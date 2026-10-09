// panthr-ocr: the text on screen in video stills, with Apple's Vision.
//   panthr-ocr frame1.jpg frame2.jpg ...
// One JSON line per image: {"file", "lines": [{"text", "confidence", "box": [x, y, w, h]}]}
// with the box in fractions of the frame, measured from the top left.
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    var lines: [[String: Any]] = []
    if let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
        for case let o as VNRecognizedTextObservation in req.results ?? [] {
            guard let top = o.topCandidates(1).first else { continue }
            let b = o.boundingBox
            lines.append([
                "text": top.string,
                "confidence": (Double(top.confidence) * 100).rounded() / 100,
                "box": [b.minX, 1 - b.maxY, b.width, b.height].map { ($0 * 1000).rounded() / 1000 }
            ])
        }
    }
    let out: [String: Any] = ["file": path, "lines": lines]
    if let d = try? JSONSerialization.data(withJSONObject: out), let s = String(data: d, encoding: .utf8) { print(s) }
}
