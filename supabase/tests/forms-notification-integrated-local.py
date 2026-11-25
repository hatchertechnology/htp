"""Exercise the producer and queue successors on the same disposable Forms schema."""
import hashlib
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'producer_fixture', Path(__file__).with_name('forms-notification-producer-local.py')
)
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)
run_producer_cases = producer.cases


def claim():
    return json.loads(producer.sql('select coalesce(claim_form_delivery(),\'null\'::jsonb);'))


def finish(job):
    assert producer.sql(
        f"select finish_form_delivery('{job['id']}','{job['lease']}','sent');"
    ) == 't'


def integrated_cases():
    run_producer_cases()
    maintenance = (
        producer.ROOT / 'supabase/migrations/20261210000000_forms_notification_queue_maintenance.sql'
    ).read_text()
    assert producer.sql(
        "select max(version) from fixture_ledger;"
    ) == '20261209000000'
    producer.sql(maintenance)
    print('integrated_maintenance_sha256=' + hashlib.sha256(maintenance.encode()).hexdigest(), flush=True)
    producer.seed()

    recipient = producer.request()
    verification = claim()
    assert verification['kind'] == 'verification'
    assert verification['recipient_id'] == recipient
    assert verification['generation'] == producer.uid(8)
    finish(verification)
    assert producer.sql(
        f"select confirm_form_recipient('{recipient}','{verification['token']}');"
    ) == 't'

    assert json.loads(producer.owner(producer.accept()))['ok']
    delivery = claim()
    assert delivery['kind'] == 'response'
    assert delivery['generation'] == verification['generation']
    producer.sql(producer.close())
    assert claim() is None
    assert json.loads(producer.owner(producer.accept(16)))['ok']
    assert producer.sql('select count(*) from website_form_delivery_jobs;') == '2'
    finish(delivery)

    response_id = producer.sql(
        f"select id from website_form_responses where submission_id='{producer.uid(6)}';"
    )
    assert producer.owner(
        f"select delete_website_form_response('{producer.uid(1)}','{producer.uid(3)}','{response_id}');"
    ) == 't'
    assert producer.sql(
        f"select count(*) from forms_notification_job_admissions where job_id='{delivery['id']}';"
    ) == '0'
    print('PASS integrated producer, bounded claims, confirmation, shutdown, finish and deletion', flush=True)


if __name__ == '__main__':
    producer.cases = integrated_cases
    producer.main()
