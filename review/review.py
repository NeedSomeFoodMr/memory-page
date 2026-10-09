"""The review service for the memory page.

The page itself can only read. Review needs a few small writes, and this service is the only thing
that makes them, so that nothing wider can slip through:

  GET  /review/marks     which patterns have been looked at
  POST /review/marks     remember that a pattern was looked at
  POST /review/retire    retire one fact (Hindsight keeps it; it can be brought back)
  POST /review/restore   bring a retired fact back
  POST /review/correct   retire one fact that is out of date, and store what is true now as a new note

It never forwards a request. Each write to Hindsight is built here from a checked memory id and, where
there is one, the reader's own short text. It cannot change a memory's words, delete a memory, or reach
another bank. The one thing it adds to the memory is a correction note, written around that text. A
second correction of the same fact on the same day replaces the first one's note.

Settings come from the environment: HINDSIGHT_UPSTREAM (host:port), HINDSIGHT_BANK, HINDSIGHT_API_KEY,
REVIEW_DATA (where the marks file is kept, default /data), REVIEW_PORT (default 8080) and REVIEW_AUTHOR
(whose corrections these are, named in each correction note; optional).
"""
import datetime
import http.client
import json
import os
import re
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get('HINDSIGHT_UPSTREAM', 'hindsight:8888')
BANK = os.environ.get('HINDSIGHT_BANK', 'default')
KEY = os.environ.get('HINDSIGHT_API_KEY', '')
DATA = os.environ.get('REVIEW_DATA', '/data')
PORT = int(os.environ.get('REVIEW_PORT', '8080'))
AUTHOR = ' '.join(os.environ.get('REVIEW_AUTHOR', '').split())[:60]

MARKS = os.path.join(DATA, 'marks.json')
MEMORY_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
BODY_MOST = 16 * 1024
REASON_MOST = 300
NOTE_MOST = 1000
WAS_MOST = 2000
TAGS_MOST = 8
CONTROL = re.compile(r'[\x00-\x1f\x7f]')
SEEN_MOST = 64
MARKS_MOST = 20000
BATCH_MOST = 500
# The deepest a real request nests is {"items": [{...}]}. Anything deeper is refused before it is parsed.
DEPTH_MOST = 4

if not re.fullmatch(r'[A-Za-z0-9_.-]+', BANK):
    raise SystemExit('HINDSIGHT_BANK may hold only letters, digits, dot, dash and underscore')

if not re.fullmatch(r'[A-Za-z0-9.-]+:\d{1,5}', UPSTREAM):
    raise SystemExit('HINDSIGHT_UPSTREAM must be host:port')

lock = threading.Lock()


class Refused(Exception):
    """A request this service will not carry out, with the status to answer it with."""

    def __init__(self, status, why):
        super().__init__(why)
        self.status = status
        self.why = why


def depth_of(raw):
    """How deeply the brackets of a JSON text nest, counted without parsing it.

    Python parses JSON by recursion in C. Each request runs on its own thread, and on a small thread
    stack a body of a few thousand nested brackets overruns it and kills the whole process, before
    Python's own recursion limit is reached. So depth is measured here first, in a flat loop.
    """
    deepest = depth = 0
    quoted = escaped = False

    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 0x5c:
                escaped = True
            elif byte == 0x22:
                quoted = False
        elif byte == 0x22:
            quoted = True
        elif byte in (0x5b, 0x7b):
            depth += 1
            deepest = max(deepest, depth)
        elif byte in (0x5d, 0x7d):
            depth -= 1

    return deepest


def marks_read():
    try:
        with open(MARKS, encoding='utf-8') as held:
            marks = json.load(held)
    except (FileNotFoundError, ValueError):
        return {}

    return marks if isinstance(marks, dict) else {}


def marks_add(items):
    with lock:
        marks = marks_read()

        for memory_id, seen in items:
            marks.pop(memory_id, None)
            marks[memory_id] = seen

        # The oldest marks go first once the file is full; a pattern that old has usually been rebuilt.
        for memory_id in list(marks)[:max(0, len(marks) - MARKS_MOST)]:
            del marks[memory_id]

        os.makedirs(DATA, exist_ok=True)
        draft = MARKS + '.tmp'

        with open(draft, 'w', encoding='utf-8') as held:
            json.dump(marks, held)

        os.replace(draft, MARKS)

    return len(marks)


def memory_id_of(value):
    if not isinstance(value, str) or MEMORY_ID.fullmatch(value) is None:
        raise Refused(400, 'That is not a memory id.')

    return value


def hindsight(method, path, body=None, wait=60):
    """One call to this bank in Hindsight. `path` is always built here, never taken from a request."""
    request = urllib.request.Request(
        f'http://{UPSTREAM}/v1/default/banks/{BANK}{path}', method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {KEY}', 'content-type': 'application/json'})

    try:
        with urllib.request.urlopen(request, timeout=wait) as answer:
            told = json.loads(answer.read().decode())
    except urllib.error.HTTPError as problem:
        try:
            why = json.loads(problem.read().decode()).get('detail')
        except (ValueError, AttributeError):
            why = None

        raise Refused(problem.code if problem.code in (400, 404, 409, 422) else 502,
                      why if isinstance(why, str) else 'The memory service did not accept that.') from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
        raise Refused(502, 'The memory service could not be reached.') from None

    if not isinstance(told, dict):
        raise Refused(502, 'The memory service gave an answer this service does not understand.')

    return told


def curate(memory_id, change):
    """Sends one fixed change of state for one memory to Hindsight, and nothing else."""
    return {'id': memory_id, 'state': hindsight('PATCH', f'/memories/{memory_id}', change).get('state')}


def marked(body):
    items = body.get('items') if isinstance(body.get('items'), list) else [body]

    if len(items) == 0 or len(items) > BATCH_MOST:
        raise Refused(400, f'Send between 1 and {BATCH_MOST} marks.')

    pairs = []

    for item in items:
        if not isinstance(item, dict):
            raise Refused(400, 'A mark needs an id and what was seen.')

        seen = item.get('seen')

        if not isinstance(seen, str) or not 0 < len(seen) <= SEEN_MOST:
            raise Refused(400, 'A mark needs what was seen, as a short text.')

        pairs.append((memory_id_of(item.get('id')), seen))

    return {'marked': len(pairs), 'held': marks_add(pairs)}


def retired(body):
    reason = body.get('reason', '')

    if not isinstance(reason, str):
        raise Refused(400, 'The reason must be text.')

    change = {'state': 'invalidated'}
    reason = ' '.join(reason.split())[:REASON_MOST]

    if reason:
        change['reason'] = reason

    return curate(memory_id_of(body.get('id')), change)


def restored(body):
    return curate(memory_id_of(body.get('id')), {'state': 'valid'})


def day_of(given, now):
    """The reader's own date for a correction, if it is a date within a day of the server's; else the server's.

    The page sends the day where the reader is, so a correction made in the morning east of Greenwich is
    not dated the day before. It is only ever used as a date: anything else is ignored.
    """
    today = now.date()

    if isinstance(given, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', given):
        try:
            day = datetime.date.fromisoformat(given)
        except ValueError:
            return today.isoformat()

        if abs((day - today).days) <= 1:
            return day.isoformat()

    return today.isoformat()


def corrected(body):
    """Stores what is true now as a new note, then retires the fact it replaces.

    The note is written here, around the reader's words, and quotes the old fact so that it stands on
    its own. It is stored first, and this waits until Hindsight has really stored it: if retiring then
    fails, the old fact is still in use, the note exists, and trying again is safe.
    """
    memory_id = memory_id_of(body.get('id'))
    note = body.get('note')

    if not isinstance(note, str):
        raise Refused(400, 'Say what is true now.')

    note = ' '.join(CONTROL.sub(' ', note).split())

    if not 0 < len(note) <= NOTE_MOST:
        raise Refused(400, f'Say what is true now, in up to {NOTE_MOST} characters.')

    old = hindsight('GET', f'/memories/{memory_id}')

    if old.get('type') not in ('world', 'experience'):
        raise Refused(400, 'Only a fact can be corrected. A pattern is rebuilt from its facts.')

    if old.get('state') == 'invalidated':
        raise Refused(409, 'That fact is already retired.')

    was = ' '.join(CONTROL.sub(' ', str(old.get('text') or '').split(' | ')[0]).split())[:WAS_MOST]
    tags = ['correction'] + [tag for tag in old.get('tags') or [] if isinstance(tag, str) and 0 < len(tag) <= 40 and tag != 'correction']
    now = datetime.datetime.now(datetime.timezone.utc)
    day = day_of(body.get('day'), now)
    # One note per fact per day, under a name built here. Sending the same correction twice lands on the
    # same note, so a retry after a failure cannot pile up copies.
    name = f'corrections/{day}-{memory_id}'
    stored = hindsight('POST', '/memories', {'async': False, 'items': [{
        'content': f"Correction{' from ' + AUTHOR if AUTHOR else ''} ({day}): {note}\n\n"
                   f'This replaces an earlier memory, which is now retired: "{was}"',
        'context': 'Correction written in the Review section of the memory page',
        'document_id': name,
        'tags': tags[:TAGS_MOST],
        'timestamp': now.isoformat(timespec='seconds'),
    }]}, wait=150)

    if stored.get('success') is not True:
        raise Refused(502, 'The memory service did not store the correction. Nothing was changed.')

    try:
        done = curate(memory_id, {'state': 'invalidated', 'reason': note[:REASON_MOST]})
    except Exception:
        raise Refused(502, 'Your correction was saved as a note, but the old fact could not be retired. Try again, or retire it by hand.') from None

    return {**done, 'note': name}


WRITES = {'/review/marks': marked, '/review/retire': retired, '/review/restore': restored, '/review/correct': corrected}


class Handler(BaseHTTPRequestHandler):
    server_version = 'review'
    sys_version = ''

    def answer(self, status, told):
        body = json.dumps(told).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] != '/review/marks':
            self.answer(404, {'error': 'There is nothing here.'})
            return

        with lock:
            marks = marks_read()

        self.answer(200, {'marks': marks})

    def do_POST(self):
        try:
            act = WRITES.get(self.path.split('?')[0])

            if act is None:
                raise Refused(404, 'There is nothing here.')

            # A page on another site cannot send JSON here without asking first, and the server in front
            # refuses that asking. A browser also says where a request came from; anything but this page is refused.
            if not self.headers.get('Content-Type', '').lower().startswith('application/json'):
                raise Refused(415, 'Send JSON.')

            if self.headers.get('Sec-Fetch-Site', 'same-origin') != 'same-origin':
                raise Refused(403, 'Only the memory page may ask for this.')

            try:
                length = int(self.headers.get('Content-Length', ''))
            except ValueError:
                raise Refused(411, 'Say how long the request is.') from None

            if not 0 < length <= BODY_MOST:
                raise Refused(413, 'That request is too long.')

            raw = self.rfile.read(length)

            if depth_of(raw) > DEPTH_MOST:
                raise Refused(400, 'That request nests too deeply.')

            try:
                body = json.loads(raw.decode())
            except ValueError:
                raise Refused(400, 'That is not JSON.') from None

            if not isinstance(body, dict):
                raise Refused(400, 'Send a JSON object.')

            self.answer(200, act(body))
        except Refused as no:
            self.answer(no.status, {'error': no.why})
        except Exception as problem:
            # A full disk, a folder that cannot be written: say so plainly and keep serving.
            print(f'failed: {type(problem).__name__}', flush=True)
            self.answer(500, {'error': 'Something went wrong while saving that.'})

    def log_message(self, form, *args):
        # One line per request, without its body: reasons are the reader's own words.
        print(f'{self.command} {self.path.split("?")[0]} {args[1] if len(args) > 1 else ""}', flush=True)


if __name__ == '__main__':
    # Room to spare for each request's thread, whatever the platform's default is.
    threading.stack_size(4 * 1024 * 1024)
    print(f'review service for bank {BANK} on port {PORT}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
