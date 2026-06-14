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

/// Parse a canonical `YYYY-MM-DDTHH:MM:SS(.fff)?Z` UTC timestamp (the format
/// [`now_iso8601`] emits and every activity source stamps) into milliseconds
/// since the Unix epoch. Returns `None` for any other shape, so a caller can
/// fall back to its secondary ordering (e.g. the activity sequence) rather than
/// misread a timestamp it cannot compare like-for-like. Only an optional `Z` is
/// accepted after the seconds/fraction; a numeric offset or trailing junk yields
/// `None` rather than a wall-clock read that ignores the offset.
pub(crate) fn iso8601_to_epoch_millis(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    // Fixed-width core: `YYYY-MM-DDTHH:MM:SS` is 19 bytes.
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let field = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(range)?;
        if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse::<i64>().ok()
        } else {
            None
        }
    };
    let year = field(0..4)?;
    let month = field(5..7)?;
    let day = field(8..10)?;
    let hour = field(11..13)?;
    let minute = field(14..16)?;
    let second = field(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    // Optional fractional seconds: a `.` then one or more digits. Keep
    // millisecond resolution (the format's precision); truncate extra digits.
    let mut idx = 19;
    let mut millis = 0_i64;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let start = idx;
        let mut scale = 100;
        while let Some(&b) = bytes.get(idx) {
            if !b.is_ascii_digit() {
                break;
            }
            if idx - start < 3 {
                millis += i64::from(b - b'0') * scale;
                scale /= 10;
            }
            idx += 1;
        }
        if idx == start {
            return None; // a dot with no digits is malformed
        }
    }

    match &s[idx..] {
        "" | "Z" => {}
        _ => return None,
    }

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(secs * 1_000 + millis)
}

/// Days from 1970-01-01 to the given civil date (proleptic Gregorian), per
/// Howard Hinnant's `days_from_civil`. The forward complement of the
/// decomposition below.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

    #[test]
    fn iso8601_to_epoch_millis_parses_canonical_and_orders_chronologically() {
        // The epoch and a known date (matches the decomposition test above).
        assert_eq!(iso8601_to_epoch_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            iso8601_to_epoch_millis("2026-05-25T00:00:00Z"),
            Some(1_779_667_200_000)
        );
        // Millisecond fraction is honored, with or without the trailing `Z`.
        assert_eq!(
            iso8601_to_epoch_millis("2026-06-14T18:32:51.463Z"),
            iso8601_to_epoch_millis("2026-06-14T18:32:51.463")
        );
        // A later wall-clock time compares greater even when it would be a lower
        // sequence (the process-restart case the activity guard relies on).
        let earlier = iso8601_to_epoch_millis("2026-06-14T18:04:20.000Z").unwrap();
        let later = iso8601_to_epoch_millis("2026-06-14T18:25:27.631Z").unwrap();
        assert!(later > earlier);
    }

    #[test]
    fn iso8601_to_epoch_millis_rejects_non_canonical_shapes() {
        // The hand-built fixtures and any foreign format fall back to sequence
        // ordering by returning None here.
        assert_eq!(iso8601_to_epoch_millis("t"), None);
        assert_eq!(iso8601_to_epoch_millis(""), None);
        assert_eq!(iso8601_to_epoch_millis("2026-06-14 18:32:51Z"), None); // space, not T
        assert_eq!(iso8601_to_epoch_millis("2026-06-14T18:32:51+02:00"), None); // offset
        assert_eq!(iso8601_to_epoch_millis("2026-13-01T00:00:00Z"), None); // bad month
        assert_eq!(iso8601_to_epoch_millis("2026-06-14T18:32:51.Z"), None); // dot, no digits
    }
}
