"""A YAML alias bomb is a coded 400, and the server stays healthy."""

from fastapi.testclient import TestClient

from nurse_scheduling.server.app import create_app


def _alias_bomb() -> str:
    text = "a: &a [x, x, x, x, x, x, x, x, x]\n"
    previous = "a"
    for i in range(1, 9):
        text += f"a{i}: &a{i} [" + ", ".join([f"*{previous}"] * 9) + "]\n"
        previous = f"a{i}"
    return text


def test_yaml_bomb_is_a_coded_400(monkeypatch):
    monkeypatch.setenv("JOB_BACKEND", "memory")
    with TestClient(create_app(start_background=False)) as client:
        response = client.post("/optimize", data={"yaml_content": _alias_bomb()})
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "scheduling_data_too_complex"
        assert client.get("/info").status_code == 200
