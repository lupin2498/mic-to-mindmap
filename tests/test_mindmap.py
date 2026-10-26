from app.mindmap import MAX_DEPTH, count_nodes, normalize_mindmap, to_markdown


def test_normalize_accepts_alternative_keys_and_strings():
    raw = {"name": "Gốc", "nodes": [{"label": "A", "items": ["a1", {"text": "a2"}]}, "B", {"title": "  "}]}
    tree = normalize_mindmap(raw, root_title="x")
    assert tree == {
        "title": "Gốc",
        "children": [
            {"title": "A", "children": [{"title": "a1", "children": []}, {"title": "a2", "children": []}]},
            {"title": "B", "children": []},
        ],
    }


def test_normalize_handles_dict_of_lists_and_dedupes():
    raw = {"Chủ đề": {"Nhánh 1": ["x", "x", "y"], "Nhánh 2": "z"}}
    tree = normalize_mindmap(raw)
    assert tree["title"] == "Chủ đề"
    assert [c["title"] for c in tree["children"]] == ["Nhánh 1", "Nhánh 2"]
    assert [c["title"] for c in tree["children"][0]["children"]] == ["x", "y"]


def test_normalize_limits_depth():
    node = {"title": "leaf"}
    for level in range(10):
        node = {"title": f"l{level}", "children": [node]}
    tree = normalize_mindmap(node)

    def depth(n):
        return 1 + max((depth(c) for c in n["children"]), default=0)

    assert depth(tree) == MAX_DEPTH


def test_list_becomes_children_of_root_and_markdown():
    tree = normalize_mindmap(["a", "b"], root_title="Họp")
    assert count_nodes(tree) == 3
    assert to_markdown(tree) == "# Họp\n- a\n- b"
    assert normalize_mindmap(None) is None
