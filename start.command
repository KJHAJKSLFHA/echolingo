#!/bin/bash
# EchoLingo 一键启动：双击本文件即可。
# 会在本机 127.0.0.1 上起一个静态服务器，并用默认浏览器打开。
# 服务器只监听本机回环地址，局域网内其他设备无法访问。

cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 /usr/bin/python3 /usr/local/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "没有找到 python3。请先安装 Python 3，或改用任何静态服务器托管本目录。"
  echo "例如：npx serve .   或   php -S 127.0.0.1:8765"
  read -r -p "按回车键关闭…" _
  exit 1
fi

echo "使用 $PY 启动…"
"$PY" tools/serve.py 8765 --open
