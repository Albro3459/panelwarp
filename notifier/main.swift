// Panelwarp's macOS notifier (built into notifier/Panelwarp.app by scripts/build-notifier.sh).
//   Panelwarp.app/Contents/MacOS/panelwarp-notifier <title> <body> [url...]
// posts one notification and exits (exit 3: notifications not allowed, 4: posting failed). A click
// relaunches the app without arguments; it opens the notification's URLs one after another (the
// first one usually brings the right VS Code window forward) and exits.
import AppKit
import UserNotifications

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    // Set before launch finishes, or the click that launched us isn't delivered.
    UNUserNotificationCenter.current().delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count >= 2 {
      post(title: args[0], body: args[1], urls: Array(args.dropFirst(2)))
    } else {
      // Launched for a click: its response arrives through the delegate.
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
    }
  }

  func post(title: String, body: String, urls: [String]) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert]) { granted, error in
      guard granted else {
        FileHandle.standardError.write("notifications not allowed: \(error?.localizedDescription ?? "denied")\n".data(using: .utf8)!)
        exit(3)
      }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.userInfo = ["urls": urls]
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
        if let error {
          FileHandle.standardError.write("could not post: \(error.localizedDescription)\n".data(using: .utf8)!)
          exit(4)
        }
        // Stay briefly, so a click right away still reaches this process.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
      }
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .list])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    let urls = (response.notification.request.content.userInfo["urls"] as? [String] ?? []).compactMap(URL.init(string:))
    done()
    open(urls[...])
  }

  /// Opens the URLs in order, giving each a moment (a window has to come forward before the next).
  func open(_ urls: ArraySlice<URL>) {
    guard let url = urls.first else { exit(0) }
    NSWorkspace.shared.open(url)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.open(urls.dropFirst()) }
  }
}

let app = NSApplication.shared
let notifier = Notifier()
app.delegate = notifier
app.run()
