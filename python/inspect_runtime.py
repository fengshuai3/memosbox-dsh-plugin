"""Preparation-time inventory. Uses the installed wheel; no model/app imports."""
import hashlib
import importlib.metadata
import json
from pathlib import Path

import mirobody
from mirobody.kernel import metrics

root = Path(mirobody.__file__).parent
bundles = list(root.rglob("*.tar.gz"))
if len(bundles) != 1:
    raise RuntimeError("EXPECTED_ONE_BUNDLED_CORPUS")
bundle = bundles[0]
catalog = root / "res" / "metrics.tsv"
licenses = []
installed = []
for dist in importlib.metadata.distributions():
    installed.append({"name": dist.metadata["Name"], "version": dist.version})
    for entry in dist.files or []:
        if any(x in str(entry).upper() for x in ("LICENSE", "NOTICE", "COPYING")):
            location = Path(dist.locate_file(entry))
            if location.is_file():
                licenses.append({"package": dist.metadata["Name"], "path": str(location), "sha256": hashlib.sha256(location.read_bytes()).hexdigest()})
print(json.dumps({"mirobodyVersion": mirobody.__version__, "bundleVersion": mirobody.BUNDLE_VERSION,
                  "bundlePath": str(bundle), "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
                  "deviceCatalogVersion": metrics.TERMINOLOGY_VERSION, "deviceCatalogPath": str(catalog),
                  "deviceCatalogSha256": hashlib.sha256(catalog.read_bytes()).hexdigest(), "licenseFiles": licenses,
                  "installedDistributions": sorted(installed, key=lambda item: item["name"].lower())}))
