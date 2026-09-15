"""Real library contract suite. Explicit prepared runtime; no mocks or keys.

Run with the provisioned Python, -I -B, from the plugin directory.
All generated input is synthetic and retained only in a test temp directory.
"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "python" / "memosbox_mirobody_worker.py"


def make_pdf(page_texts):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]
    kids = []
    for text in page_texts:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        kids.append(f"{page_id} 0 R")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents {stream_id} 0 R >>".encode())
        stream = f"BT /F1 12 Tf 40 700 Td ({text}) Tj ET".encode() if text else b""
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
    data = b"%PDF-1.4\n"
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    data += f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return data


class RealWorker(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="synthetic-worker-", dir=ROOT / ".runtime")
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def request(self, operation, payload, limits=None):
        request = {"schemaVersion": 1, "operationId": "synthetic-contract", "operation": operation, "payload": payload, "limits": limits or {}}
        result = subprocess.run([sys.executable, "-I", "-B", str(WORKER)], input=json.dumps(request), capture_output=True, text=True, timeout=30,
                                env={"PATH": "/usr/bin:/bin", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1"}, cwd=self.root)
        self.assertEqual(result.stderr, "", "worker must never log source content or tracebacks")
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["operation"], operation)
        self.assertEqual(parsed["schemaVersion"], 1)
        self.assertEqual(parsed["operationId"], "synthetic-contract")
        return parsed

    def document(self, data, kind, limits=None):
        path = self.root / "synthetic.input"
        path.write_bytes(data)
        return self.request("extract_document", {"sourcePath": str(path), "sourceDigest": hashlib.sha256(data).hexdigest(), "format": kind}, limits)

    def test_real_status_and_versions(self):
        result = self.request("status", {})
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["runtime"]["mirobodyVersion"], "1.4.2")
        self.assertEqual(result["bundleVersion"], "loinc-2.82+2026.08.28-af2524b7a285")
        self.assertEqual(result["runtime"]["isolation"], "unverified")

    def test_resolve_reading_golden_and_refusal(self):
        result = self.request("normalize_readings", {"readings": [
            {"rawName": "血红蛋白"}, {"rawName": "total cholesterol", "rawValue": "5.0", "rawUnit": "mmol/L"},
            {"rawName": "中性粒细胞", "rawValue": "4.2", "rawUnit": "10*9/L"},
            {"rawName": "血脂"}, {"rawName": "not-a-real-indicator-xyzzy"}]})
        self.assertEqual([r["code"] for r in result["readings"][:3]], ["718-7", "14647-2", "26499-4"])
        self.assertEqual(result["readings"][3]["status"], "refused")
        self.assertEqual(result["readings"][4]["status"], "unresolved")
        self.assertEqual(result["status"], "partial")

    def test_raw_values_never_coerced_or_converted(self):
        values = ["<0.001", "1–2", "-1.50e-9", "阴性", "9007199254740993.000001", "NaN", "5 mmol/L"]
        result = self.request("normalize_readings", {"readings": [{"rawName": "hemoglobin", "rawValue": value, "rawUnit": "g/L"} for value in values]})
        self.assertEqual([r["rawValue"] for r in result["readings"]], values)
        self.assertEqual([r["normalizedValue"] for r in result["readings"]], values)
        self.assertIn("NON_FINITE_VALUE_PRESERVED_NOT_CONVERTED", result["readings"][5]["warnings"])
        self.assertIn("INLINE_UNIT_CONFLICT", result["readings"][6]["warnings"])
        self.assertEqual(result["readings"][5]["status"], "unresolved")
        self.assertEqual(result["readings"][6]["code"], "")

    def test_serum_analytes_never_resolve_to_meld_score(self):
        for name, expected in [("Serum Creatinine", "2160-0"), ("Serum Total Bilirubin", "1975-2")]:
            with self.subTest(name=name):
                result = self.request("resolve", {"rawName": name, "rawValue": "<1.00", "rawUnit": "mg/dL"})
                reading = result["readings"][0]
                self.assertEqual(reading["code"], expected)
                self.assertNotEqual(reading["code"], "44760-7")
                self.assertEqual(reading["rawValue"], "<1.00")
                self.assertEqual(reading["normalizedValue"], "<1.00")
                self.assertEqual(reading["normalizedUnit"], "mg/dL")

    def test_device_metric_actual_catalogue(self):
        result = self.request("metric_info", {"name": "heartRates"})
        self.assertEqual(result["metric"]["state_class"], "instant")
        self.assertEqual(result["metric"]["aggregation_policy"], "mean_min_max")
        self.assertEqual(self.request("metric_info", {"name": "unknown-device-metric"})["status"], "unresolved")

    def test_text_gbk_blank_line_positions(self):
        result = self.document("合成报告\n\n血红蛋白 130 g/L\n".encode("gbk"), "text")
        self.assertEqual(result["status"], "ready")
        self.assertEqual([s["location"]["line"] for s in result["segments"]], [1, 3])
        self.assertEqual(result["segments"][1]["text"], "血红蛋白 130 g/L")

    def test_mixed_pdf_pages_keep_missing_ocr(self):
        result = self.document(make_pdf(["SYNTHETIC report: hemoglobin 130 g/L. This text layer is deliberately longer than forty characters.", ""]), "pdf")
        self.assertEqual(result["status"], "partial")
        self.assertEqual([s["location"]["page"] for s in result["segments"]], [1, 2])
        self.assertEqual([s["status"] for s in result["segments"]], ["ready", "needs_ocr"])
        self.assertIn("OCR_NOT_PERFORMED", result["warnings"])

    def test_pdf_page_limit_is_visible(self):
        result = self.document(make_pdf(["", ""]), "pdf", {"maxPdfPages": 1})
        self.assertTrue(result["truncated"])
        self.assertIn("PDF_PAGE_LIMIT", result["warnings"])

    def test_xlsx_preserves_rows_columns_sheets_formulas(self):
        from openpyxl import Workbook
        book = Workbook()
        book.active.title = "synthetic-a"
        book.active["B3"] = "Hemoglobin"
        book.active["C3"] = 130
        book.create_sheet("synthetic-b")["D5"] = "=1+2"
        buffer = io.BytesIO()
        book.save(buffer)
        result = self.document(buffer.getvalue(), "xlsx")
        positions = [(s["location"]["sheet"], s["location"]["row"], s["location"]["column"]) for s in result["segments"]]
        self.assertEqual(positions, [("synthetic-a", 3, 2), ("synthetic-a", 3, 3), ("synthetic-b", 5, 4)])
        self.assertIn("XLSX_FORMULA_NOT_EVALUATED", result["warnings"])
        self.assertIn("XLSX_NUMERIC_OR_DATE_VALUE_NOT_ORIGINAL_DISPLAY", result["warnings"])
        self.assertFalse(result["segments"][1]["provenance"]["originalDisplayAvailable"])

    def test_refuse_mismatched_formats_and_bad_digest(self):
        self.assertEqual(self.document(b"not a PDF", "pdf")["error"]["code"], "FORMAT_SIGNATURE_MISMATCH")
        path = self.root / "source"
        path.write_text("synthetic")
        result = self.request("extract_document", {"sourcePath": str(path), "sourceDigest": "0" * 64, "format": "text"})
        self.assertEqual(result["error"]["code"], "SOURCE_DIGEST_OR_SIZE_MISMATCH")

    def test_batch_and_input_validation(self):
        self.assertEqual(self.request("normalize_readings", {"readings": [{"rawName": "hemoglobin"}] * 257})["error"]["code"], "READING_BATCH_LIMIT")
        self.assertEqual(self.request("resolve", {"rawName": "hemoglobin", "rawValue": 13})["error"]["code"], "INVALID_STRING")
        unknown = self.request("resolve", {"rawName": "hemoglobin", "rawValue": "13", "rawUnit": "arbitrary-invented-unit"})
        self.assertEqual(unknown["readings"][0]["status"], "unresolved")
        self.assertEqual(unknown["readings"][0]["code"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
