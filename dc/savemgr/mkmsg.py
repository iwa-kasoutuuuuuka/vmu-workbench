#!/usr/bin/env python3
# msg_ja.txt (UTF-8、1 行 = 「名前<空白>文」) から msg.h を作る。文は Shift-JIS (cp932) にして \x で書く。
# Shift-JIS の 2 バイト目には '\' (0x5C) があるので、そのままソースに書くと文字列が壊れるため。
import sys

def c_literal(text):
    out = []
    prev_hex = False
    for b in text.encode('cp932'):
        ch = chr(b)
        if 0x20 <= b < 0x7f and ch not in '"\\':
            if prev_hex and ch in '0123456789abcdefABCDEF':
                out.append('" "')        # \x の後に 16 進の文字が続くと 1 つの \x に読まれるので区切る
            out.append(ch)
            prev_hex = False
        else:
            out.append('\\x%02x' % b)
            prev_hex = True
    return '"' + ''.join(out) + '"'

def main(src, dst):
    lines = ['/* mkmsg.py が msg_ja.txt から作るファイル。直接書き換えない */', '#ifndef MSG_H', '#define MSG_H']
    with open(src, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            raw = raw.rstrip('\r\n')
            if not raw.strip() or raw.lstrip().startswith('#'):
                continue
            name, _, text = raw.partition(' ')
            if not name.isidentifier():
                sys.exit('%s:%d: bad name %r' % (src, n, name))
            text = text.strip().replace('\\n', '\n')
            lines.append('#define M_%s %s' % (name, c_literal(text)))
    lines.append('#endif')
    with open(dst, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
