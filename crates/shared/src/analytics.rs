//! Website-scoped Google Analytics reporting contract.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// A bounded GA4 daily report request. The property ID is numeric, not a G- tag.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnalyticsRequest {
    pub property_id: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
}

impl AnalyticsRequest {
    /// Validate before contacting Google.
    ///
    /// # Errors
    /// Rejects invalid property IDs and date ranges exceeding 366 inclusive days.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.property_id.is_empty()
            || self.property_id.len() > 20
            || self.property_id.starts_with('0')
            || !self.property_id.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("Use a numeric GA4 property ID, not a G- measurement ID.");
        }
        let days = (self.end_date - self.start_date).num_days();
        if !(0..366).contains(&days) {
            return Err("The date range must be ordered and contain at most 366 days.");
        }
        Ok(())
    }
}

/// Google's original report (including headers, metadata and any thresholds).
#[derive(Debug, Deserialize, Serialize)]
pub struct AnalyticsReport {
    pub website: crate::Website,
    pub property_id: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub report: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_real_dates_property_ids_and_bounded_ranges() {
        let mut request = AnalyticsRequest {
            property_id: "123456".into(),
            start_date: "2026-01-01".parse().unwrap(),
            end_date: "2026-12-31".parse().unwrap(),
        };
        assert!(request.validate().is_ok());
        request.end_date = "2027-01-02".parse().unwrap();
        assert!(request.validate().is_err());
        request.end_date = "2025-12-31".parse().unwrap();
        assert!(request.validate().is_err());
        request.end_date = request.start_date;
        for id in ["", "0", "G-123", "properties/123", "../123", "123?x=1"] {
            request.property_id = id.into();
            assert!(request.validate().is_err());
        }
        assert!("2026-02-30".parse::<NaiveDate>().is_err());
    }
}
