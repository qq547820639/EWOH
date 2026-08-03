package ewoh.deploy

default allow = false

allow {
  input.artifacts_present == true
  input.checks_passed >= 3
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
  input.checks_passed < 3
  msg := "not enough checks passed"
}
