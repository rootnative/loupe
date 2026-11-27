import Network
import UIKit
import XCTest

// One UI test that serves XCUITest on 127.0.0.1:LOUPE_PORT until it gets
// `quit`. Each request is one JSON object on one line, with "cmd" and an
// optional "id"; each answer is one JSON object on one line, with "ok",
// "ms" and the same "id". An XCUITest call that fails gives "ok" false,
// with each failure in "issues". XCUITest calls run on the main thread, so
// the test keeps the main run loop going while the listener waits on its
// own queue.
//
// With LOUPE_TOKEN, each request must carry that value as "token": the port
// is open to each process of the Mac, and only the process that started the
// runner knows the token. With LOUPE_IDLE_SECONDS, the test ends after that
// time with no request, so a runner that nobody uses doesn't stay.
final class Runner: XCTestCase {
  /// The XCTest failures of the request that runs now; nil between
  /// requests. Read and written on the main thread only.
  static var issues: [String]?

  // A failed XCUITest call is the answer to its request, not a failed test:
  // xcodebuild must still end with 0 after `quit`.
  override func record(_ issue: XCTIssue) {
    guard Runner.issues != nil else {
      super.record(issue)
      return
    }
    let line = issue.sourceCodeContext.location.map { " (line \($0.lineNumber))" } ?? ""
    Runner.issues?.append(issue.compactDescription + line)
  }

  func testServe() throws {
    continueAfterFailure = true
    let environment = ProcessInfo.processInfo.environment
    let raw = environment["LOUPE_PORT"].flatMap { UInt16($0) } ?? 22087
    guard let port = NWEndpoint.Port(rawValue: raw) else {
      throw Failure("LOUPE_PORT isn't a port.")
    }
    let token = environment["LOUPE_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
    let idle = environment["LOUPE_IDLE_SECONDS"].flatMap { TimeInterval($0) }
    let server = try Server(port: port, token: token)
    server.start()
    while !server.done {
      _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
      if let idle, Date().timeIntervalSince(server.lastRequest) > idle {
        print("loupe runner: no request in \(Int(idle)) s, so it stops")
        break
      }
    }
  }
}

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

final class Server {
  /// Read and written on the main thread only.
  var done = false
  /// When the last request came. Read and written on the main thread only.
  var lastRequest = Date()
  private let listener: NWListener
  private let queue = DispatchQueue(label: "loupe.runner")
  private let handler: Handler

  init(port: NWEndpoint.Port, token: String?) throws {
    handler = Handler(token: token)
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // The simulator shares the Mac's network, so any other address would
    // open the runner to the local network.
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
    listener = try NWListener(using: parameters)
  }

  func start() {
    listener.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        print("loupe runner: ready on 127.0.0.1:\(self?.listener.port?.rawValue ?? 0)")
      case .failed(let error):
        print("loupe runner: the listener failed: \(error)")
        DispatchQueue.main.async { self?.done = true }
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      connection.start(queue: self?.queue ?? .main)
      self?.receive(on: connection, buffer: Data())
    }
    listener.start(queue: queue)
  }

  private func receive(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = Data(buffer[buffer.startIndex..<newline])
        buffer = Data(buffer[buffer.index(after: newline)...])
        let (answer, quit) = DispatchQueue.main.sync {
          self.lastRequest = Date()
          return self.handler.answer(line)
        }
        connection.send(
          content: answer + Data([0x0A]),
          completion: .contentProcessed { _ in
            if quit { DispatchQueue.main.async { self.done = true } }
          })
      }
      if isComplete || error != nil {
        connection.cancel()
      } else {
        self.receive(on: connection, buffer: buffer)
      }
    }
  }
}

final class Handler {
  private let springboard = "com.apple.springboard"
  private let token: String?

  init(token: String?) { self.token = token }

  func answer(_ line: Data) -> (Data, Bool) {
    let started = Date()
    var reply: [String: Any]
    var quit = false
    var id: Any?
    Runner.issues = []
    do {
      guard let request = try JSONSerialization.jsonObject(with: line) as? [String: Any],
        let command = request["cmd"] as? String
      else { throw Failure("A request is a JSON object with \"cmd\".") }
      id = request["id"]
      if let token, request["token"] as? String != token {
        throw Failure("The request doesn't have the token of this runner.")
      }
      quit = command == "quit"
      reply = try run(command, request)
    } catch {
      reply = ["error": "\(error)"]
    }
    let issues = Runner.issues ?? []
    Runner.issues = nil
    if !issues.isEmpty {
      reply["issues"] = issues
      if reply["error"] == nil { reply["error"] = issues[0] }
    }
    reply["ok"] = reply["error"] == nil
    if let id { reply["id"] = id }
    reply["ms"] = Int(Date().timeIntervalSince(started) * 1000)
    let data =
      (try? JSONSerialization.data(withJSONObject: reply))
      ?? Data("{\"ok\":false,\"error\":\"The answer isn't valid JSON.\"}".utf8)
    return (data, quit)
  }

  private func run(_ command: String, _ request: [String: Any]) throws -> [String: Any] {
    switch command {
    case "ping":
      let info = Bundle(for: Runner.self).infoDictionary ?? [:]
      return [
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "builtWith": info["DTXcode"] ?? NSNull(),
        "builtWithBuild": info["DTXcodeBuild"] ?? NSNull(),
        "sdk": info["DTSDKName"] ?? NSNull(),
        "orientation": name(of: XCUIDevice.shared.orientation),
      ]
    case "tree":
      return ["tree": node(try app(request).snapshot())]
    case "state":
      return ["state": name(of: app(request).state)]
    case "frame":
      return ["frame": json(app(request).frame)]
    case "tap":
      return try tap(request)
    case "drag":
      return try drag(request)
    case "type":
      guard let text = request["text"] as? String else { throw Failure("type needs \"text\".") }
      app(request).typeText(text)
      return [:]
    case "home":
      XCUIDevice.shared.press(.home)
      return [:]
    case "orientation":
      if let wanted = request["set"] as? String {
        guard let orientation = orientations[wanted] else {
          throw Failure("Unknown orientation \(wanted).")
        }
        XCUIDevice.shared.orientation = orientation
      }
      return ["orientation": name(of: XCUIDevice.shared.orientation)]
    case "screenshot":
      let shot = XCUIScreen.main.screenshot()
      return [
        "png": shot.pngRepresentation.base64EncodedString(),
        // Pixels per point of the screen.
        "scale": Double(shot.image.scale),
      ]
    case "quit":
      return [:]
    default:
      throw Failure("Unknown command \(command).")
    }
  }

  private func app(_ request: [String: Any]) -> XCUIApplication {
    XCUIApplication(bundleIdentifier: request["app"] as? String ?? springboard)
  }

  private func tap(_ request: [String: Any]) throws -> [String: Any] {
    let app = app(request)
    if let element = try element(in: app, request) {
      let frame = element.frame
      element.tap()
      return ["frame": json(frame)]
    }
    coordinate(app, try point(request, "x", "y")).tap()
    return [:]
  }

  private func drag(_ request: [String: Any]) throws -> [String: Any] {
    let app = app(request)
    let from = coordinate(app, try point(request, "x", "y"))
    let to = coordinate(app, try point(request, "toX", "toY"))
    from.press(
      forDuration: (request["pressMs"] as? Double ?? 50) / 1000,
      thenDragTo: to,
      withVelocity: XCUIGestureVelocity(rawValue: CGFloat(request["velocity"] as? Double ?? 1000)),
      thenHoldForDuration: (request["holdEndMs"] as? Double ?? 0) / 1000)
    return [:]
  }

  /// The element that "identifier" or "label" names; nil when the request names a point.
  private func element(in app: XCUIApplication, _ request: [String: Any]) throws -> XCUIElement? {
    let predicate: NSPredicate
    if let identifier = request["identifier"] as? String {
      predicate = NSPredicate(format: "identifier == %@", identifier)
    } else if let label = request["label"] as? String {
      predicate = NSPredicate(format: "label == %@", label)
    } else {
      return nil
    }
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    guard element.exists else { throw Failure("No element matches \(predicate.predicateFormat).") }
    return element
  }

  private func coordinate(_ app: XCUIApplication, _ point: CGPoint) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
  }

  private func point(_ request: [String: Any], _ x: String, _ y: String) throws -> CGPoint {
    guard let px = request[x] as? Double, let py = request[y] as? Double else {
      throw Failure("The request needs \"\(x)\" and \"\(y)\".")
    }
    return CGPoint(x: px, y: py)
  }

  private func node(_ element: XCUIElementSnapshot) -> [String: Any] {
    var entry: [String: Any] = ["type": name(of: element.elementType), "frame": json(element.frame)]
    if !element.identifier.isEmpty { entry["identifier"] = element.identifier }
    if !element.label.isEmpty { entry["label"] = element.label }
    if !element.title.isEmpty { entry["title"] = element.title }
    if let value = element.value { entry["value"] = "\(value)" }
    if let placeholder = element.placeholderValue, !placeholder.isEmpty {
      entry["placeholder"] = placeholder
    }
    if !element.isEnabled { entry["disabled"] = true }
    if element.isSelected { entry["selected"] = true }
    let children = element.children.map(node)
    if !children.isEmpty { entry["children"] = children }
    return entry
  }

  private func json(_ rect: CGRect) -> [String: Double] {
    [
      "x": Double(rect.origin.x), "y": Double(rect.origin.y),
      "width": Double(rect.width), "height": Double(rect.height),
    ]
  }

  private let orientations: [String: UIDeviceOrientation] = [
    "portrait": .portrait, "portraitUpsideDown": .portraitUpsideDown,
    "landscapeLeft": .landscapeLeft, "landscapeRight": .landscapeRight,
  ]

  private func name(of orientation: UIDeviceOrientation) -> String {
    switch orientation {
    case .portrait: return "portrait"
    case .portraitUpsideDown: return "portraitUpsideDown"
    case .landscapeLeft: return "landscapeLeft"
    case .landscapeRight: return "landscapeRight"
    case .faceUp: return "faceUp"
    case .faceDown: return "faceDown"
    case .unknown: return "unknown"
    @unknown default: return "other-\(orientation.rawValue)"
    }
  }

  private func name(of state: XCUIApplication.State) -> String {
    switch state {
    case .unknown: return "unknown"
    case .notRunning: return "notRunning"
    case .runningBackgroundSuspended: return "runningBackgroundSuspended"
    case .runningBackground: return "runningBackground"
    case .runningForeground: return "runningForeground"
    @unknown default: return "other-\(state.rawValue)"
    }
  }

  private func name(of type: XCUIElement.ElementType) -> String {
    switch type {
    case .other: return "other"
    case .application: return "application"
    case .group: return "group"
    case .window: return "window"
    case .sheet: return "sheet"
    case .alert: return "alert"
    case .dialog: return "dialog"
    case .button: return "button"
    case .keyboard: return "keyboard"
    case .key: return "key"
    case .navigationBar: return "navigationBar"
    case .tabBar: return "tabBar"
    case .toolbar: return "toolbar"
    case .statusBar: return "statusBar"
    case .table: return "table"
    case .cell: return "cell"
    case .collectionView: return "collectionView"
    case .scrollView: return "scrollView"
    case .staticText: return "staticText"
    case .textField: return "textField"
    case .secureTextField: return "secureTextField"
    case .textView: return "textView"
    case .searchField: return "searchField"
    case .image: return "image"
    case .icon: return "icon"
    case .link: return "link"
    case .switch: return "switch"
    case .toggle: return "toggle"
    case .slider: return "slider"
    case .segmentedControl: return "segmentedControl"
    case .picker: return "picker"
    case .pageIndicator: return "pageIndicator"
    case .progressIndicator: return "progressIndicator"
    case .activityIndicator: return "activityIndicator"
    case .webView: return "webView"
    case .menu: return "menu"
    case .menuItem: return "menuItem"
    case .popover: return "popover"
    default: return "type-\(type.rawValue)"
    }
  }
}
