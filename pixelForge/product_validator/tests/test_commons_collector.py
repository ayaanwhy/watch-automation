import unittest

from product_validator.collectors.commons import clean_metadata, license_allowed


class CommonsCollectorTests(unittest.TestCase):
    def test_accepts_only_configured_reuse_licenses(self):
        self.assertTrue(license_allowed("CC0"))
        self.assertTrue(license_allowed("Public domain"))
        self.assertTrue(license_allowed("CC BY 4.0"))
        self.assertFalse(license_allowed("CC BY-SA 4.0"))
        self.assertFalse(license_allowed("All rights reserved"))

    def test_cleans_html_attribution(self):
        self.assertEqual(clean_metadata("<b>Alice</b> &amp; Bob"),
                         "Alice & Bob")


if __name__ == "__main__":
    unittest.main()

