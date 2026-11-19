# Vendor invoice lookup: mock tests

Loads the Suitelet with fake `N/` modules (`mock.js`) and checks it without NetSuite.

```bash
npm install --prefix /tmp/pdflibs pdfjs-dist@3.11.174 pdf-lib@1.17.1 playwright
node tests/test_server.js nts_vendor_doc_lookup_sl.js nts_vendor_doc_match_ue.js <baseline SL> <baseline UE>
node tests/test_browser.js nts_vendor_doc_lookup_sl.js /tmp/pdflibs/node_modules <output folder>
```

- `test_server.js`: protected lines, log titles, AP/TMT toggle placement, `&mode=lib`, uploads and attaches,
  and access scope (subsidiaries and AP/TMT per person). The baseline files are the versions before a change;
  pass the current files twice to skip the "changed since" checks' meaning.
- `test_browser.js`: drives the real page in Chromium with the real pdf.js and pdf-lib: the toggle, the PDF
  viewer and notes, and the PDFs that get uploaded.

These are mock tests: they prove the script's logic, not NetSuite's behavior (SuiteQL tables, permissions, limits).
