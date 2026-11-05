#!/bin/bash
set -euo pipefail
# awslocal uses only LocalStack's local AWS endpoint. Never configure production credentials here.
python3 - <<'PY'
import json, os, subprocess
count = os.environ.get('SQS_MAX_RECEIVE_COUNT', '5')
if not count.isdecimal() or not 1 <= int(count) <= 1000:
    raise ValueError('SQS_MAX_RECEIVE_COUNT must be 1..1000')
def aws(*args):
    return json.loads(subprocess.check_output(['awslocal', 'sqs', *args, '--output', 'json'], text=True) or '{}')
def queue(name, attributes):
    attrs = json.dumps(attributes)
    lookup = subprocess.run(['awslocal', 'sqs', 'get-queue-url', '--queue-name', name, '--output', 'json'], capture_output=True, text=True)
    if lookup.returncode == 0:
        url = json.loads(lookup.stdout)['QueueUrl']
    elif 'NonExistentQueue' in lookup.stderr or 'QueueDoesNotExist' in lookup.stderr:
        url = aws('create-queue', '--queue-name', name, '--attributes', attrs)['QueueUrl']
    else:
        raise RuntimeError('LocalStack queue lookup failed')
    mutable = {k: v for k, v in attributes.items() if k != 'FifoQueue'}
    aws('set-queue-attributes', '--queue-url', url, '--attributes', json.dumps(mutable))
    return url
base = {'FifoQueue': 'true', 'ContentBasedDeduplication': 'false', 'VisibilityTimeout': '30'}
dlq = queue('wager-transactions-dlq.fifo', base)
arn = aws('get-queue-attributes', '--queue-url', dlq, '--attribute-names', 'QueueArn')['Attributes']['QueueArn']
queue('wager-transactions.fifo', {**base, 'RedrivePolicy': json.dumps({'deadLetterTargetArn': arn, 'maxReceiveCount': count})})
queue('wagering-events.fifo', base)
print('Jungle SQS: three FIFO queues provisioned; redrive configured.')
PY
