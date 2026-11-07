import pathlib

p = pathlib.Path(__file__).resolve().parent / "home" / "config" / "config.toml"
t = p.read_text(encoding="utf-8")
old = 'pprof_laddr = "localhost:6060"'
new = 'pprof_laddr = "127.0.0.1:6060"'
assert old in t, "pprof line not found"
p.write_text(t.replace(old, new), encoding="utf-8")
print("patched pprof -> 127.0.0.1:6060")
