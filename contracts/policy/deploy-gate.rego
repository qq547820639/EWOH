package ewoh.deploy

# 部署门禁（CFG-005 修正）：不再按 checks_passed 数量放行，而是按命名必检项
# 逐项校验。input.checks 为 {id, passed} 对象数组，按下方 canonical 顺序给出
# （命名必检项 = Makefile contract-* 门禁族）：
#   checks[0] = contract-identity   契约身份规范校验
#   checks[1] = contract-domain     域契约注册表交叉核对
#   checks[2] = contract-envelope   事件信封语义校验
# 任一必检项缺失（数组越界/无该字段）、id 不符或 passed != true → deny。
# 缺省 default allow = false（fail-closed）。

default allow = false

allow {
  input.artifacts_present == true
  input.checks.0.id == "contract-identity"
  input.checks.0.passed == true
  input.checks.1.id == "contract-domain"
  input.checks.1.passed == true
  input.checks.2.id == "contract-envelope"
  input.checks.2.passed == true
  input.missing_contracts == 0
}

deny[msg] {
  input.missing_contracts > 0
  msg := "missing contracts"
}

deny[msg] {
  input.artifacts_present == false
  msg := "artifacts missing"
}

deny[msg] {
  input.checks.0.id != "contract-identity"
  msg := "required check missing: contract-identity"
}

deny[msg] {
  input.checks.0.passed != true
  msg := "required check not passed: contract-identity"
}

deny[msg] {
  input.checks.1.id != "contract-domain"
  msg := "required check missing: contract-domain"
}

deny[msg] {
  input.checks.1.passed != true
  msg := "required check not passed: contract-domain"
}

deny[msg] {
  input.checks.2.id != "contract-envelope"
  msg := "required check missing: contract-envelope"
}

deny[msg] {
  input.checks.2.passed != true
  msg := "required check not passed: contract-envelope"
}
