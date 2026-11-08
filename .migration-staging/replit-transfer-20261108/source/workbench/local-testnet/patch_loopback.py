import pathlib

p = pathlib.Path(__file__).resolve().parent / "home" / "config" / "app.toml"
t = p.read_text(encoding="utf-8")
pairs = [
    ('address = "tcp://localhost:1317"', 'address = "tcp://127.0.0.1:1317"'),
    ('address = "localhost:9090"', 'address = "127.0.0.1:9090"'),
]
for old, new in pairs:
    assert old in t, f"not found: {old}"
    t = t.replace(old, new)
p.write_text(t, encoding="utf-8")
print("patched api/grpc to 127.0.0.1")
