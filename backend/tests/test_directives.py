"""指令字典端点。"""


def test_directives_list_nonempty(client, auth_headers):
    r = client.get("/api/directives", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) > 10
    names = {d["name"] for d in body}
    assert {"listen", "proxy_pass", "server_name"} <= names
    for d in body:
        assert d["name"] and d["description"] and d["context"]
