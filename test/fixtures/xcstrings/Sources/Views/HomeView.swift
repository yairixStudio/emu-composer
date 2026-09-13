import SwiftUI

struct HomeView: View {
    var body: some View {
        VStack {
            Text("Welcome back")
            Text("Just a caption")
            NavigationLink(String(localized: "settings.title")) { SettingsView() }
        }
    }
}
