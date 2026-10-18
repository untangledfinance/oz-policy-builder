| mutant | weakened check | result | first failing check | harness | time |
|---|---|---|---|---|---|
| o53 | transfer: the end time is exclusive (boundary second) | killed | B1. | stopped at the first failure | 244s |
| o54 | transfer: a not-after equal to now is refused (boundary second) | killed | B2. | stopped at the first failure | 256s |
