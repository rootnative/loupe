// simtool: way A of the iOS driver spike (recorder round 11). It reads the
// macOS Accessibility tree of the Simulator window and posts CGEvents to it.
// Each command prints one JSON object; a failure prints {"error": ...} and
// exits with 1. Points are device points from the top-left corner of the
// device screen; `--size <w>x<h>` gives the screen size in points.
//
//   simtool trusted
//   simtool window [--title <part>]
//   simtool tree [--title <part>]
//   simtool activate
//   simtool tap <x> <y> --size <w>x<h> [--via hid|pid] [--title <part>]
//   simtool drag <x> <y> <toX> <toY> --size <w>x<h> [--ms 300] [--steps 20]
//                [--hold-end 0] [--via hid|pid] [--title <part>]
//   simtool key <combo> [--via hid|pid]          for example cmd+left
//   simtool menu <menu> <item>                   for example Device "Rotate Left"

import AppKit
import ApplicationServices

let simulatorID = "com.apple.iphonesimulator"
let maxNodes = 4000

struct Failure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

func emit(_ object: [String: Any]) {
  let data =
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    ?? Data("{\"error\":\"The answer isn't valid JSON.\"}".utf8)
  FileHandle.standardOutput.write(data + Data([0x0A]))
}


struct Arguments {
  var positional: [String] = []
  var options: [String: String] = [:]

  init(_ raw: ArraySlice<String>) {
    var rest = raw
    while let word = rest.popFirst() {
      if word.hasPrefix("--"), let value = rest.popFirst() {
        options[String(word.dropFirst(2))] = value
      } else {
        positional.append(word)
      }
    }
  }

  func number(_ index: Int) throws -> Double {
    guard index < positional.count, let value = Double(positional[index]) else {
      throw Failure("Argument \(index + 1) must be a number.")
    }
    return value
  }

  func option(_ name: String, _ fallback: Double) throws -> Double {
    guard let raw = options[name] else { return fallback }
    guard let value = Double(raw) else { throw Failure("--\(name) must be a number.") }
    return value
  }

  func size() throws -> CGSize {
    let parts = (options["size"] ?? "").split(separator: "x").compactMap { Double($0) }
    guard parts.count == 2, parts[0] > 0, parts[1] > 0 else {
      throw Failure("--size must be <width>x<height> in points.")
    }
    return CGSize(width: parts[0], height: parts[1])
  }

  var via: String { options["via"] ?? "hid" }
}


func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success
  else { return nil }
  return value
}

func text(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let string = value as? String { return string.isEmpty ? nil : string }
  if CFGetTypeID(value) == AXValueGetTypeID() { return nil }
  return "\(value)"
}

func flag(_ element: AXUIElement, _ name: String) -> Bool? {
  attribute(element, name) as? Bool
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute),
    let size = attribute(element, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(),
    CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  AXValueGetValue(position as! AXValue, .cgPoint, &point)
  AXValueGetValue(size as! AXValue, .cgSize, &extent)
  return CGRect(origin: point, size: extent)
}

func json(_ rect: CGRect) -> [String: Double] {
  [
    "x": Double(rect.origin.x), "y": Double(rect.origin.y),
    "width": Double(rect.width), "height": Double(rect.height),
  ]
}

func simulator() throws -> NSRunningApplication {
  guard
    let app = NSRunningApplication.runningApplications(withBundleIdentifier: simulatorID).first
  else { throw Failure("The Simulator app doesn't run.") }
  return app
}

func frontmost() -> String {
  NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none"
}

func window(_ app: NSRunningApplication, _ title: String?) throws -> AXUIElement {
  let windows =
    attribute(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute)
    as? [AXUIElement] ?? []
  guard
    let found = windows.first(where: { window in
      title.map { text(window, kAXTitleAttribute)?.contains($0) ?? false } ?? true
    })
  else { throw Failure("No Simulator window\(title.map { " has \"\($0)\" in its title" } ?? "").") }
  return found
}

/// The device screen: the largest group in the window, two levels down at most.
func screen(of window: AXUIElement) throws -> (element: AXUIElement, frame: CGRect) {
  var best: (element: AXUIElement, frame: CGRect)?
  var level = children(window)
  for _ in 0..<2 {
    for element in level where text(element, kAXRoleAttribute) == "AXGroup" {
      if let rect = frame(element), rect.width * rect.height > (best?.frame).map({ $0.width * $0.height }) ?? 0 {
        best = (element, rect)
      }
    }
    level = level.flatMap(children)
  }
  guard let best else { throw Failure("The Simulator window has no device screen group.") }
  return best
}

func node(_ element: AXUIElement, depth: Int, count: inout Int) -> [String: Any] {
  count += 1
  var entry: [String: Any] = [:]
  let names: [(String, String)] = [
    ("role", kAXRoleAttribute), ("subrole", kAXSubroleAttribute),
    ("roleDescription", kAXRoleDescriptionAttribute), ("title", kAXTitleAttribute),
    ("label", kAXDescriptionAttribute), ("value", kAXValueAttribute),
    ("identifier", kAXIdentifierAttribute), ("help", kAXHelpAttribute),
  ]
  for (key, name) in names {
    if let value = text(element, name) { entry[key] = value }
  }
  if let rect = frame(element) { entry["frame"] = json(rect) }
  if flag(element, kAXEnabledAttribute) == false { entry["disabled"] = true }
  if flag(element, kAXFocusedAttribute) == true { entry["focused"] = true }
  if flag(element, kAXSelectedAttribute) == true { entry["selected"] = true }
  var actions: CFArray?
  if AXUIElementCopyActionNames(element, &actions) == .success,
    let list = actions as? [String], !list.isEmpty
  {
    entry["actions"] = list
  }
  if depth < 60 {
    var kids: [[String: Any]] = []
    for child in children(element) where count < maxNodes {
      kids.append(node(child, depth: depth + 1, count: &count))
    }
    if !kids.isEmpty { entry["children"] = kids }
  }
  return entry
}


func requireFrontmost(_ via: String) throws {
  if via == "hid", frontmost() != simulatorID {
    throw Failure("The Simulator isn't frontmost (\(frontmost()) is), so an HID event could land in another app.")
  }
}

func post(_ event: CGEvent, via: String, pid: pid_t) {
  if via == "pid" { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
}

func mouse(_ type: CGEventType, _ point: CGPoint) throws -> CGEvent {
  guard
    let event = CGEvent(
      mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
  else { throw Failure("macOS gave no mouse event.") }
  return event
}

func screenPoint(_ x: Double, _ y: Double, _ size: CGSize, _ screen: CGRect) throws -> CGPoint {
  let point = CGPoint(
    x: screen.minX + x * screen.width / size.width,
    y: screen.minY + y * screen.height / size.height)
  guard screen.contains(point) else {
    throw Failure("The point (\(x), \(y)) is outside the device screen.")
  }
  return point
}

// The Simulator loses the last event when the process exits right after it.
func settleEvents() { usleep(200_000) }

let keyCodes: [String: CGKeyCode] = [
  "left": 123, "right": 124, "down": 125, "up": 126, "return": 36, "escape": 53,
  "delete": 51, "tab": 48, "space": 49, "h": 4, "k": 40, "r": 15, "d": 2,
]
let modifiers: [String: CGEventFlags] = [
  "cmd": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "ctrl": .maskControl,
]


func run(_ command: String, _ args: Arguments) throws -> [String: Any] {
  switch command {
  case "trusted":
    return [
      "accessibility": AXIsProcessTrusted(),
      "postEvent": CGPreflightPostEventAccess(),
      "screenCapture": CGPreflightScreenCaptureAccess(),
      "frontmost": frontmost(),
    ]

  case "window":
    let app = try simulator()
    let found = try window(app, args.options["title"])
    let device = try? screen(of: found)
    return [
      "pid": Int(app.processIdentifier),
      "frontmost": frontmost(),
      "title": text(found, kAXTitleAttribute) ?? "",
      "window": frame(found).map(json) ?? [:],
      "screen": device.map { json($0.frame) } ?? [:],
      "children": children(found).map { child in
        [
          "role": text(child, kAXRoleAttribute) ?? "",
          "subrole": text(child, kAXSubroleAttribute) ?? "",
          "frame": frame(child).map(json) ?? [:],
        ]
      },
    ]

  case "tree":
    let started = Date()
    let device = try screen(of: try window(try simulator(), args.options["title"]))
    var count = 0
    let tree = node(device.element, depth: 0, count: &count)
    return [
      "screen": json(device.frame), "nodes": count, "truncated": count >= maxNodes,
      "ms": Int(Date().timeIntervalSince(started) * 1000), "tree": tree,
    ]

  case "activate":
    let started = Date()
    _ = try simulator().activate(options: [.activateIgnoringOtherApps])
    while frontmost() != simulatorID, Date().timeIntervalSince(started) < 2 { usleep(20_000) }
    return [
      "frontmost": frontmost(), "ms": Int(Date().timeIntervalSince(started) * 1000),
    ]

  case "tap":
    let app = try simulator()
    let device = try screen(of: try window(app, args.options["title"]))
    let point = try screenPoint(try args.number(0), try args.number(1), try args.size(), device.frame)
    try requireFrontmost(args.via)
    post(try mouse(.leftMouseDown, point), via: args.via, pid: app.processIdentifier)
    usleep(60_000)
    post(try mouse(.leftMouseUp, point), via: args.via, pid: app.processIdentifier)
    settleEvents()
    return ["screenPoint": ["x": Double(point.x), "y": Double(point.y)], "via": args.via, "frontmost": frontmost()]

  case "drag":
    let app = try simulator()
    let device = try screen(of: try window(app, args.options["title"]))
    let size = try args.size()
    let from = try screenPoint(try args.number(0), try args.number(1), size, device.frame)
    let to = try screenPoint(try args.number(2), try args.number(3), size, device.frame)
    let steps = max(1, Int(try args.option("steps", 20)))
    let pause = useconds_t(try args.option("ms", 300) * 1000 / Double(steps))
    try requireFrontmost(args.via)
    post(try mouse(.leftMouseDown, from), via: args.via, pid: app.processIdentifier)
    for step in 1...steps {
      let share = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share)
      usleep(pause)
      post(try mouse(.leftMouseDragged, point), via: args.via, pid: app.processIdentifier)
    }
    usleep(useconds_t(try args.option("hold-end", 0) * 1000))
    post(try mouse(.leftMouseUp, to), via: args.via, pid: app.processIdentifier)
    settleEvents()
    return ["via": args.via, "frontmost": frontmost()]

  case "key":
    let app = try simulator()
    guard let combo = args.positional.first else { throw Failure("key needs a combo, for example cmd+left.") }
    var flags: CGEventFlags = []
    var code: CGKeyCode?
    for part in combo.lowercased().split(separator: "+").map(String.init) {
      if let modifier = modifiers[part] {
        flags.insert(modifier)
      } else if let key = keyCodes[part] {
        code = key
      } else {
        throw Failure("Unknown key \(part).")
      }
    }
    guard let code else { throw Failure("The combo \(combo) has no key.") }
    try requireFrontmost(args.via)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
      else { throw Failure("macOS gave no key event.") }
      event.flags = flags
      post(event, via: args.via, pid: app.processIdentifier)
      usleep(30_000)
    }
    settleEvents()
    return ["via": args.via, "frontmost": frontmost()]

  case "menu":
    guard args.positional.count == 2 else { throw Failure("menu needs a menu and an item.") }
    let app = AXUIElementCreateApplication(try simulator().processIdentifier)
    guard let bar = attribute(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID()
    else { throw Failure("The Simulator has no menu bar.") }
    let barElement = bar as! AXUIElement
    guard
      let menu = children(barElement).first(where: { text($0, kAXTitleAttribute) == args.positional[0] }),
      let item = children(menu).flatMap(children).first(where: {
        text($0, kAXTitleAttribute) == args.positional[1]
      })
    else { throw Failure("No menu item \(args.positional[0]) > \(args.positional[1]).") }
    let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
    guard result == .success else { throw Failure("The menu item didn't take the press (\(result.rawValue)).") }
    return ["frontmost": frontmost()]

  default:
    throw Failure("Unknown command \(command). See the top of simtool.swift.")
  }
}

let words = CommandLine.arguments.dropFirst()
do {
  guard let command = words.first else { throw Failure("Give a command. See the top of simtool.swift.") }
  emit(try run(command, Arguments(words.dropFirst())))
} catch let failure as Failure {
  emit(["error": failure.message])
  exit(1)
} catch {
  emit(["error": "\(error)"])
  exit(1)
}
