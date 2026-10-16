// panthr-input: where the pointer goes and clicks while the screen is recorded.
//   panthr-input [--window <CGWindowID>]
// JSON lines on stdout, until stdin closes (or it is killed):
//   {"t": 1.25, "type": "click", "x": 812, "y": 455, "button": "left"}
//   {"t": 1.31, "type": "up", ...}  {"t": …, "type": "move", ...}  {"t": …, "type": "scroll", ...}
//   {"t": …, "type": "key"}          that a key was pressed, never which (needs Accessibility; else none)
//   {"t": …, "type": "bounds", "x", "y", "w", "h"}   the recorded window's frame (with --window), when it moves
// Points, in global screen coordinates from the top left of the main display;
// t in seconds since it started.
import Cocoa

setvbuf(stdout, nil, _IOLBF, 0)
let start = Date()
let primaryHeight = NSScreen.screens.first?.frame.height ?? 0

func out(_ d: [String: Any]) {
    if let j = try? JSONSerialization.data(withJSONObject: d), let s = String(data: j, encoding: .utf8) { print(s) }
}
func now() -> Double { Date().timeIntervalSince(start) }
func pointer() -> (Double, Double) {
    let p = NSEvent.mouseLocation
    return (Double(p.x), Double(primaryHeight - p.y))
}

var lastMove = -1.0
_ = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .leftMouseUp, .rightMouseUp, .mouseMoved, .leftMouseDragged, .scrollWheel, .keyDown]) { e in
    let t = now()
    let (x, y) = pointer()
    switch e.type {
    case .leftMouseDown, .rightMouseDown:
        out(["t": t, "type": "click", "x": x, "y": y, "button": e.type == .rightMouseDown ? "right" : "left", "count": e.clickCount])
    case .leftMouseUp, .rightMouseUp:
        out(["t": t, "type": "up", "x": x, "y": y])
    case .mouseMoved, .leftMouseDragged:
        // At most 20 a second.
        if t - lastMove >= 0.05 {
            lastMove = t
            out(["t": t, "type": "move", "x": x, "y": y])
        }
    case .scrollWheel:
        out(["t": t, "type": "scroll", "x": x, "y": y])
    case .keyDown:
        out(["t": t, "type": "key"])
    default:
        break
    }
}

// The recorded window's frame, now and whenever it changes.
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--window"), i + 1 < args.count, let id = UInt32(args[i + 1]) {
    var last = ""
    let tick = {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
              let b = info.first?[kCGWindowBounds as String] as? [String: Double] else { return }
        let key = "\(b["X"] ?? 0),\(b["Y"] ?? 0),\(b["Width"] ?? 0),\(b["Height"] ?? 0)"
        if key == last { return }
        last = key
        out(["t": now(), "type": "bounds", "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0])
    }
    tick()
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in tick() }
}

// Ends when Panther closes its stdin.
FileHandle.standardInput.readabilityHandler = { h in
    if h.availableData.isEmpty { exit(0) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
