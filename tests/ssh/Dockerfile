# Throwaway SSH server for ZawSQL's SSH tunnel tests.
# The account, password and keys in this folder are public test fixtures: never use them anywhere else.
#
#   docker build -t zawsql-test-sshd tests/ssh
#   docker run -d -p 2222:22 zawsql-test-sshd
FROM alpine:3.21
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tunnel \
 && echo 'tunnel:tunnel-pass' | chpasswd \
 && sed -i \
      -e 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' \
      -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' \
      -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
      /etc/ssh/sshd_config
COPY test_ed25519.pub test_rsa.pub /tmp/
RUN mkdir -p /home/tunnel/.ssh \
 && cat /tmp/test_ed25519.pub /tmp/test_rsa.pub > /home/tunnel/.ssh/authorized_keys \
 && chown -R tunnel:tunnel /home/tunnel/.ssh \
 && chmod 700 /home/tunnel/.ssh \
 && chmod 600 /home/tunnel/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
