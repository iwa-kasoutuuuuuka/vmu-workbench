#!/usr/bin/env python3
# www/index.html を C の配列 (www.h) にする。test/savemgr-http.test.js も同じ形を JS で作る
import sys

def main(src, dst):
    data = open(src, 'rb').read()
    lines = ['/* mkwww.py が www/index.html から作るファイル。直接書き換えない */',
             'static const unsigned char www_index[] = {']
    for i in range(0, len(data), 24):
        lines.append('    ' + ','.join(str(b) for b in data[i:i + 24]) + ',')
    lines.append('};')
    lines.append('static const unsigned int www_index_len = %d;' % len(data))
    with open(dst, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
