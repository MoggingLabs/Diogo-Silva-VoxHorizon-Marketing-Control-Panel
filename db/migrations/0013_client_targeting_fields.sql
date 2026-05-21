alter table client_profiles
  add column targeting_address      text,
  add column targeting_zip          text,
  add column targeting_radius_miles numeric;

comment on column client_profiles.targeting_radius_miles is
  'Ad geo-targeting radius in miles from targeting_zip/address. NULL = not set (a gap, tracked in needs_input). Parsed from source targeting text where present (e.g. "150 miles from 91405"); most clients have no explicit radius.';
