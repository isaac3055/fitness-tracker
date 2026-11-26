import XCTest
@testable import FitnessTracker
final class FitnessTrackerTests: XCTestCase {
 func testMissingEnergyIsUnknown() {
  XCTAssertNil(EnergyTotal(intake:1800,active:nil,resting:1600).deficit)
 }
 func testEnergyIncludesActiveOnlyOnce() {
  XCTAssertEqual(EnergyTotal(intake:1800,active:600,resting:1600).deficit,400)
 }
 func testLocalDayBoundary() throws {
  let date=try XCTUnwrap(ISO8601DateFormatter().date(from:"2026-01-01T18:00:00Z"))
  XCTAssertEqual(HealthDates.day(date,timezone:try XCTUnwrap(TimeZone(identifier:"Asia/Shanghai"))),"2026-01-02")
 }

}
