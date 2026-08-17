# Coverage Report — 二轮审计文件覆盖账本

- 生成时间: 2026-08-17T13:24:48.837Z
- 活跃文件总数: 2095
- 已逐行复审 (reviewed=true): 2095
- active_unread_files: 0
- partial_review_files (reviewed 但无 ranges): 0
- 总行数: 399261

## 排除项声明

- release/、delivery/、output/：打包副本与生成产物，不逐行重复审计；生产引用与版本边界核查见 final-assessment.md。
- node_modules、lock 文件、二进制资产、*.min.* bundle、openapi.d.ts（codegen 产物，由 openapi:no-drift 门禁保障）。
- docs/（本审计体系自身输出与历史报告，非工程代码）；.codex/、.trae/（流程制品）。

## 域分布

| domain | files | reviewed | lines |
| --- | --- | --- | --- |
| app-config | 201 | 201 | 37660 |
| catalog | 14 | 14 | 858 |
| ci | 8 | 8 | 2186 |
| client | 604 | 604 | 93637 |
| contracts | 91 | 91 | 12009 |
| database | 181 | 181 | 17838 |
| deploy | 34 | 34 | 1516 |
| edge | 265 | 265 | 57479 |
| feishu | 29 | 29 | 7341 |
| openapi | 3 | 3 | 20773 |
| py-contracts | 43 | 43 | 10871 |
| root | 10 | 10 | 3183 |
| scripts | 73 | 73 | 16616 |
| security | 4 | 4 | 126 |
| server | 454 | 454 | 102039 |
| shared | 55 | 55 | 10434 |
| tools | 26 | 26 | 4695 |

## 终态断言

- active_unread_files = 0 ✓
- partial_review_files = 0 ✓
