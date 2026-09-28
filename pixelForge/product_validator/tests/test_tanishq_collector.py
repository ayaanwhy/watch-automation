import unittest

from product_validator.collectors.tanishq import (
    MISSING_IMAGE_STATUSES, canonical_product_url, gallery_url, product_code)


class TanishqCollectorTests(unittest.TestCase):
    def test_extracts_product_code_and_cleans_tracking_query(self):
        raw = (
            "https://www.tanishq.co.in/product/woven-spark-diamond-"
            "finger-ring-50d6jdfbpaa26.html?lang=en_IN&utm_source=test")
        self.assertEqual(product_code(raw), "50D6JDFBPAA26")
        self.assertEqual(
            canonical_product_url(raw),
            "https://www.tanishq.co.in/product/woven-spark-diamond-"
            "finger-ring-50d6jdfbpaa26.html?lang=en_IN")

    def test_builds_unversioned_gallery_url(self):
        self.assertEqual(
            gallery_url("50D6JDFBPAA26", 4, 1200),
            "https://www.tanishq.co.in/dw/image/v2/BKCK_PRD/"
            "on/demandware.static/-/Sites-Tanishq-product-catalog/default/"
            "images/hi-res/50D6JDFBPAA26_4.jpg?sw=1200&sh=1200")

    def test_rejects_non_product_or_non_tanishq_urls(self):
        with self.assertRaises(ValueError):
            product_code("https://example.com/product/item-1234567890.html")
        with self.assertRaises(ValueError):
            product_code("https://www.tanishq.co.in/shop/rings")

    def test_demandware_missing_image_statuses_are_known(self):
        self.assertEqual(MISSING_IMAGE_STATUSES, {404, 500})


if __name__ == "__main__":
    unittest.main()
