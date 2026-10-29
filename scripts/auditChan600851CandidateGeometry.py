#!/usr/bin/env python3
"""Independently enumerate a bounded set of 600851 long-segment candidates.

This is a price-geometry audit, not an alternative complete segment engine.
It assumes the project-extracted pen points and the original start are valid.
No production JavaScript is imported, and output is written only to stdout.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / 'test-results/chan-600851-long-segment-audit-2026-10-28/input-and-pens.json'
SNAPSHOT_HASH = '611babdde928f04a179b6b0db770605f04e2ced38a8263aac6861307109d9e6d'


def normalize(points, starts):
    """Merge containment within one side of a hypothetical up-segment pivot.

    The initial up direction and strict comparisons are this project's declared
    convention. Keep the original high-point index to test pivot anchoring.
    """
    result = []
    for index in starts:
        one, two = points[index], points[index + 1]
        item = {
            'low': min(one['price'], two['price']),
            'high': max(one['price'], two['price']),
            'high_index': index if one['price'] >= two['price'] else index + 1,
        }
        if not result:
            result.append(item)
            continue
        last = result[-1]
        contained = ((last['low'] <= item['low'] and last['high'] >= item['high'])
                     or (item['low'] <= last['low'] and item['high'] >= last['high']))
        if not contained:
            result.append(item)
            continue
        direction = ('up' if len(result) == 1 or last['high'] > result[-2]['high'] else 'down')
        chooser = max if direction == 'up' else min
        choose_new_high = item['high'] > last['high'] if direction == 'up' else item['high'] < last['high']
        result[-1] = {
            'low': chooser(last['low'], item['low']),
            'high': chooser(last['high'], item['high']),
            'high_index': item['high_index'] if choose_new_high else last['high_index'],
        }
    return result


def main():
    data = json.loads(AUDIT.read_text())
    source = ROOT / data['source']
    actual_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if data['source_sha256'] != SNAPSHOT_HASH or actual_hash != SNAPSHOT_HASH:
        raise ValueError('unexpected candle snapshot: stop instead of comparing unlike data')
    points = data['pens']
    if points[3]['date'] != '2024-07-09' or points[30]['date'] != '2026-03-10':
        raise ValueError('unexpected long-segment endpoints')
    if any(not point['confirmed'] for point in points[:39]):
        raise ValueError('unexpected unconfirmed point in the audit window')

    candidates = []
    # Long segment starts at point 3. Only odd-length ends through point 30 are
    # eligible for an up-segment boundary. Later confirmed points provide proof.
    for pivot in range(6, 31, 2):
        left = normalize(points, range(4, pivot, 2))[-1]
        first = {'low': points[pivot + 1]['price'], 'high': points[pivot]['price']}
        first_break_encloses_left = first['low'] <= left['low'] and first['high'] >= left['high']
        three = [(min(points[i]['price'], points[i + 1]['price']),
                  max(points[i]['price'], points[i + 1]['price'])) for i in range(pivot, pivot + 3)]
        reverse_first_three_overlap = max(item[0] for item in three) < min(item[1] for item in three)

        earliest_top = None
        # Construct each observable right-side prefix separately, never merge it
        # across the hypothetical pivot with the left-side feature.
        for feature_index in range(pivot + 2, len(points) - 1, 2):
            if not points[feature_index + 1]['confirmed']:
                break
            right_side = normalize(points, range(pivot, feature_index + 1, 2))
            if len(right_side) < 2:
                continue
            middle, right = right_side[:2]
            top = (middle['high'] > left['high'] and middle['low'] > left['low']
                   and middle['high'] > right['high'] and middle['low'] > right['low'])
            if top and middle['high_index'] == pivot:
                earliest_top = {
                    'confirmed': points[feature_index + 1]['confirmedDate'],
                    'left': [left['low'], left['high']],
                    'middle': [middle['low'], middle['high']],
                    'right': [right['low'], right['high']],
                }
                break
        candidates.append({
            'pivot': points[pivot]['date'], 'price': points[pivot]['price'],
            'reverse_first_three_overlap': reverse_first_three_overlap,
            'first_break_encloses_left': first_break_encloses_left,
            'first_pivot_anchored_formal_top': earliest_top,
        })

    print(json.dumps({
        'source_sha256': actual_hash,
        'upstream': 'project pen endpoints assumed, not independently verified',
        'window': '2024-07-09 to 2026-03-10; later confirmed pens through 2026-09-21',
        'limitations': 'formal geometry only; no decision on 71/81 rule conflicts, OHLC order, '
                       'other starts, pen correctness, data completeness or original-image parity',
        'candidates': candidates,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
