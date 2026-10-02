# SSH test fixtures

Public test fixtures for ZawSQL's SSH tunnel tests: a throwaway OpenSSH server image and the key pairs it accepts.
**Never use these keys or passwords for anything real.**

| Fixture | Value |
| --- | --- |
| User / password | `tunnel` / `tunnel-pass` |
| `test_ed25519` | ed25519 key, no passphrase |
| `test_rsa` | RSA key, passphrase `key-passphrase` |

```sh
docker build -t zawsql-test-sshd tests/ssh
docker run -d --name zawsql-sshd -p 2222:22 zawsql-test-sshd
export ZAWSQL_TEST_SSH_HOST=127.0.0.1 ZAWSQL_TEST_SSH_PORT=2222
# MySQL as seen from inside the SSH container, e.g. another container on the same network:
export ZAWSQL_TEST_SSH_DB_HOST=mysql ZAWSQL_TEST_SSH_DB_PORT=3306
```
