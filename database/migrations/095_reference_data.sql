-- =============================================================================
-- 006_reference_data.sql
-- GST state codes and units of measure.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

INSERT INTO erp.states (code, name) VALUES
  ('01', 'Jammu and Kashmir'), ('02', 'Himachal Pradesh'), ('03', 'Punjab'),
  ('04', 'Chandigarh'), ('05', 'Uttarakhand'), ('06', 'Haryana'), ('07', 'Delhi'),
  ('08', 'Rajasthan'), ('09', 'Uttar Pradesh'), ('10', 'Bihar'), ('11', 'Sikkim'),
  ('12', 'Arunachal Pradesh'), ('13', 'Nagaland'), ('14', 'Manipur'), ('15', 'Mizoram'),
  ('16', 'Tripura'), ('17', 'Meghalaya'), ('18', 'Assam'), ('19', 'West Bengal'),
  ('20', 'Jharkhand'), ('21', 'Odisha'), ('22', 'Chhattisgarh'), ('23', 'Madhya Pradesh'),
  ('24', 'Gujarat'), ('26', 'Dadra and Nagar Haveli and Daman and Diu'), ('27', 'Maharashtra'),
  ('29', 'Karnataka'), ('30', 'Goa'), ('31', 'Lakshadweep'), ('32', 'Kerala'),
  ('33', 'Tamil Nadu'), ('34', 'Puducherry'), ('35', 'Andaman and Nicobar Islands'),
  ('36', 'Telangana'), ('37', 'Andhra Pradesh'), ('38', 'Ladakh'), ('97', 'Other Territory')
ON CONFLICT (code) DO NOTHING;

-- gst_uqc = Unit Quantity Code used in GSTR-1 HSN summary.
INSERT INTO erp.units (code, name, gst_uqc, decimals) VALUES
  ('PCS',  'Pieces',        'PCS', 0),
  ('NOS',  'Numbers',       'NOS', 0),
  ('SQFT', 'Square feet',   'SQF', 2),
  ('SQM',  'Square metre',  'SQM', 3),
  ('RFT',  'Running feet',  'OTH', 2),
  ('MTR',  'Metre',         'MTR', 3),
  ('KG',   'Kilogram',      'KGS', 3),
  ('BOX',  'Box',           'BOX', 0),
  ('SET',  'Set',           'SET', 0),
  ('PAIR', 'Pair',          'PRS', 0),
  ('ROLL', 'Roll',          'ROL', 0),
  ('BDL',  'Bundle',        'BDL', 0)
ON CONFLICT (code) DO NOTHING;

RESET ROLE;
