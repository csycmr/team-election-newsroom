from app.services.demo_service import demo_snapshot


def test_demo_snapshot_is_consistent():
    snapshot = demo_snapshot(3, "중구")
    assert snapshot.mode == "demo"
    assert snapshot.region == "중구"
    assert abs(sum(item.vote_rate for item in snapshot.candidates) - 100) <= 0.2
    assert snapshot.collected_at.utcoffset().total_seconds() == 9 * 3600


def test_demo_stream_changes_by_step():
    first = demo_snapshot(1)
    second = demo_snapshot(2)
    assert second.candidates[0].votes > first.candidates[0].votes
    assert second.counted_rate > first.counted_rate

