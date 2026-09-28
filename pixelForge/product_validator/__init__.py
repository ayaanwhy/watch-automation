"""Independent product/type/view validation pipeline.

This package deliberately has no imports from ``vto`` or ``deploy``.  It can
be trained, evaluated and exported without modifying the production
segmentation models.
"""

from .taxonomy import (ASSET_CLASSES, QUALITY_FLAGS, ROTATION_CLASSES,
                       VIEW_CLASSES)

__all__ = ["ASSET_CLASSES", "QUALITY_FLAGS", "ROTATION_CLASSES",
           "VIEW_CLASSES"]
