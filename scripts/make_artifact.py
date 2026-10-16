import re, pathlib
src = pathlib.Path('dist-single/index.html').read_text()
head = src[:src.index('</head>')]
title = re.search(r'<title>(.*?)</title>', head, re.S).group(1)
style_start = head.rindex('<style')
style = head[style_start:head.index('</style>', style_start) + len('</style>')]
script_start = head.index('<script type="module"')
script_end = head.rindex('</script>', 0, style_start) + len('</script>')
script = head[script_start:script_end]
out = '\n'.join([f'<title>{title}</title>', style, '<div id="root"></div>', script])
dst = pathlib.Path('artifact/flowcanvas.html')
dst.parent.mkdir(exist_ok=True)
dst.write_text(out)
print(dst, dst.stat().st_size, 'bytes')

# full HTML document for self-hosting / sharing as a file (keeps doctype and charset)
sa = pathlib.Path('artifact/flowstate-standalone.html')
sa.write_text(src)
print(sa, sa.stat().st_size, 'bytes')
