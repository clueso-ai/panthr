// panthr-capture: records a display or a window to an MP4 with ScreenCaptureKit.
//   panthr-capture --display <CGDirectDisplayID> | --window <CGWindowID>
//                  --out <file.mp4> [--no-cursor] [--mic] [--fps 30]
// Prints {"type":"started","width":…,"height":…} once frames flow, and
// {"type":"done"} or {"type":"error","message":…} at the end. Stops (and
// finishes the file) when stdin closes. The pointer can be left out of the
// picture (--no-cursor); Panthr notes its movements anyway (panthr-input).
import AVFoundation
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)
func say(_ d: [String: Any]) {
    if let j = try? JSONSerialization.data(withJSONObject: d), let s = String(data: j, encoding: .utf8) { print(s) }
}
func fail(_ m: String) -> Never {
    say(["type": "error", "message": m])
    exit(1)
}

let args = CommandLine.arguments
func value(_ k: String) -> String? {
    guard let i = args.firstIndex(of: k), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let outPath: String = value("--out") ?? ""
if outPath.isEmpty { fail("--out is needed") }
let displayID = value("--display").flatMap { UInt32($0) }
let windowID = value("--window").flatMap { UInt32($0) }
let showCursor = !args.contains("--no-cursor")
let mic = args.contains("--mic")
let fps = Int32(value("--fps") ?? "30") ?? 30

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var writer: AVAssetWriter?
    var video: AVAssetWriterInput?
    var audio: AVAssetWriterInput?
    var started = false
    var stopping = false
    let queue = DispatchQueue(label: "panthr.capture")

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let filter: SCContentFilter
            var size: CGSize
            var scale: CGFloat = 2
            if let id = windowID {
                guard let w = content.windows.first(where: { $0.windowID == id }) else { fail("That window is gone") }
                filter = SCContentFilter(desktopIndependentWindow: w)
                size = w.frame.size
                if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
            } else {
                let d = content.displays.first(where: { $0.displayID == (displayID ?? CGMainDisplayID()) }) ?? content.displays.first
                guard let d = d else { fail("No display to record") }
                // Panthr's own windows stay out of the picture.
                let mine = content.windows.filter { $0.owningApplication?.bundleIdentifier == "io.clueso.panthr" }
                filter = SCContentFilter(display: d, excludingWindows: mine)
                size = CGSize(width: d.width, height: d.height)
                if #available(macOS 14.0, *) { scale = CGFloat(filter.pointPixelScale) }
            }
            // Pixels, even, at most 3840 wide.
            var w = Int(size.width * scale), h = Int(size.height * scale)
            if w > 3840 { h = h * 3840 / w; w = 3840 }
            w -= w % 2; h -= h % 2

            let cfg = SCStreamConfiguration()
            cfg.width = w
            cfg.height = h
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
            cfg.showsCursor = showCursor
            cfg.queueDepth = 6
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            if mic {
                if #available(macOS 15.0, *) { cfg.captureMicrophone = true } else { fail("Recording your voice needs macOS 15") }
            }

            let url = URL(fileURLWithPath: outPath)
            try? FileManager.default.removeItem(at: url)
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: w,
                AVVideoHeightKey: h,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(8_000_000, w * h * 6), AVVideoExpectedSourceFrameRateKey: fps]
            ])
            v.expectsMediaDataInRealTime = true
            writer.add(v)
            if mic {
                let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 160_000])
                a.expectsMediaDataInRealTime = true
                writer.add(a)
                self.audio = a
            }
            self.writer = writer
            self.video = v

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            if mic, #available(macOS 15.0, *) { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
            self.stream = s
            try await s.startCapture()
        } catch {
            fail(error.localizedDescription)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let writer = writer, !stopping, sb.isValid else { return }
        if type == .screen {
            // Only frames with a picture (not idle or blank status frames).
            guard let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = att.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status == .complete else { return }
            if !started {
                writer.startWriting()
                writer.startSession(atSourceTime: sb.presentationTimeStamp)
                started = true
                say(["type": "started", "width": Int(CVPixelBufferGetWidth(sb.imageBuffer!)), "height": Int(CVPixelBufferGetHeight(sb.imageBuffer!))])
            }
            if video?.isReadyForMoreMediaData == true { video?.append(sb) }
        } else if started, let a = audio, a.isReadyForMoreMediaData {
            a.append(sb)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        say(["type": "error", "message": error.localizedDescription])
        finish()
    }

    func finish() {
        queue.async {
            if self.stopping { return }
            self.stopping = true
            let s = self.stream
            Task {
                try? await s?.stopCapture()
                guard let writer = self.writer, self.started else {
                    say(["type": "error", "message": "Nothing was recorded"])
                    exit(1)
                }
                self.video?.markAsFinished()
                self.audio?.markAsFinished()
                await writer.finishWriting()
                if writer.status == .completed { say(["type": "done"]); exit(0) }
                say(["type": "error", "message": writer.error?.localizedDescription ?? "Could not finish the file"])
                exit(1)
            }
        }
    }
}

let rec = Recorder()
// Stops when Panthr closes stdin.
FileHandle.standardInput.readabilityHandler = { h in
    if h.availableData.isEmpty {
        FileHandle.standardInput.readabilityHandler = nil
        rec.finish()
    }
}
Task { await rec.start() }
RunLoop.main.run()
