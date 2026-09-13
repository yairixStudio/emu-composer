import SwiftUI

enum AppTab { case places, schedule
    var title: String {
        switch self {
        case .places:   return L(LStr.Shell.tabPlaces)
        case .schedule: return L(LStr.Shell.tabSchedule)
        }
    }
}
struct Banner: View { var body: some View { Text(L(LStr.Shell.offline)) } }
