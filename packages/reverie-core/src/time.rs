//! Dependency-free ISO 8601 wall-clock for backend-internal timestamps.
//!
//! Used where Reverie itself observes a moment that has no external timestamp to
//! borrow (a session created, a process exited). Where a producer or the
//! frontend already supplies a clock (activity `updatedAt`, the frontend's
//! last-viewed stamp), prefer that value instead of calling this.
//!
//! Output format is `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, millisecond precision) so it
//! matches the activity feed's `updatedAt` and the SQLite `strftime` backfill,
//! and sorts lexicographically in the same order as chronologically.

/// Current UTC time as an ISO 8601 string with millisecond precision.
pub(crate) fn now_iso8601() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    let (secs, millis) = match now {
        Ok(d) => (d.as_secs(), d.subsec_millis()),
        Err(_) => (0, 0),
    };
    let (year, month, day, hour, minute, second) = unix_secs_to_ymdhms(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Decompose seconds-since-epoch into UTC `(year, month, day, hour, minute,
/// second)`. Correct for all dates from 1970 to year 9999.
pub(crate) fn unix_secs_to_ymdhms(mut secs: u64) -> (u64, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    secs /= 60;
    let minute = (secs % 60) as u32;
    secs /= 60;
    let hour = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut year: u64 = 1970;
    loop {
        let year_days = if is_leap_year(year) { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = is_leap_year(year);
    let month_lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month: u32 = 1;
    for (idx, length) in month_lengths.iter().enumerate() {
        if days < *length as u64 {
            month = idx as u32 + 1;
            break;
        }
        days -= *length as u64;
    }
    let day = days as u32 + 1;
    (year, month, day, hour, minute, second)
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_secs_to_ymdhms_handles_epoch_and_known_dates() {
        assert_eq!(unix_secs_to_ymdhms(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(unix_secs_to_ymdhms(1_779_667_200), (2026, 5, 25, 0, 0, 0));
    }

    #[test]
    fn now_is_millisecond_precision_utc() {
        let now = now_iso8601();
        // YYYY-MM-DDTHH:MM:SS.mmmZ
        assert_eq!(now.len(), 24, "unexpected format: {now}");
        assert!(now.ends_with('Z'));
        assert_eq!(&now[19..20], ".");
    }
}
