# tcp-forward

Simple TCP forwarding tools

# Usage

## Direct mode

```
$ npx stcp-forward --help
选项：
  --help          显示帮助信息                                            [布尔]
  --version       显示版本号                                              [布尔]
  --listen-port   listen port                                      [数字] [必需]
  --forward-port  forward port                                     [数字] [必需]
  --binding-ip    binding ip address                             [字符串] [必需]
  --forward-ip    forward ip address                             [字符串] [必需]
```

## C/S mode

1. Generate a new `ED25519` key

   ```
   npx stcp-helper new
   ```

2. Run the `stcp-server` on a relay server with a public IP address

   ```
   $ npx stcp-server --help
   选项：
   --help             显示帮助信息                                         [布尔]
   --version          显示版本号                                           [布尔]
   --upstream-port    upstream port                                 [数字] [必需]
   --downstream-port  downstream port                               [数字] [必需]
   --binding-ip       binding ip address           [字符串] [默认值: "127.0.0.1"]
   --public-key       ED25519 public key                          [字符串] [必需]
   ```

   Example:

   ```
   npx stcp-server --upstream-port 55555 --downstream-port 55554 --binding-ip 0.0.0.0 --public-key d8a7e86670f3da498af3dd5c9dc7903efb82b6091105108bd42066a84bdfc7ca
   ```

3. Run the `stcp-client` on a client machine that does not have a public IP address

   ```
   $ npx stcp-client --help
   选项：
   --help             显示帮助信息                                         [布尔]
   --version          显示版本号                                           [布尔]
   --upstream-port    upstream port                                 [数字] [必需]
   --downstream-port  downstream port                               [数字] [必需]
   --upstream-ip      upstream ip address                         [字符串] [必需]
   --downstream-ip    downstream ip address                       [字符串] [必需]
   --proxy            connect with upstream through proxy                  [布尔]
   --proxy-username   proxy username                                     [字符串]
   --proxy-password   proxy password                                     [字符串]
   --proxy-host       proxy host                                         [字符串]
   --proxy-port       proxy port                                           [数字]
   --private-key      ED25519 private key                         [字符串] [必需]
   ```

   Example:

   ```
   npx stcp-client --upstream-port 55554 --downstream-port 80 --upstream-ip $SERVER_IP --downstream-ip "127.0.0.1" --private-key de5de99ce8ee3c3c6f1dd3db0887377e0ad45a09b1410b23abf088bd2d1baf92
   ```
