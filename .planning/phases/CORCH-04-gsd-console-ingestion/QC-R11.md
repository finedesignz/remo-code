# QC R11 - CORCH-04 (Codex, read-only; QC-FAIL, 1 MED)

All three R10 MEDs confirmed resolved. New MED: corch-no-polling-guard compares unsorted readdirSync output against an ordered array (directory-order dependent). Fixed by sorting before comparison (R12 input).
