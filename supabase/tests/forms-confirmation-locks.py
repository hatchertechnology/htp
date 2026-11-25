"""After the local SQL fixture, check revocation/transfer locks in its disposable DB.
Usage: python supabase/tests/forms-confirmation-locks.py CONTAINER DATABASE
"""
import subprocess
import sys
base=['docker','exec','-i',sys.argv[1],'psql','-U','postgres','-d',sys.argv[2],'-v','ON_ERROR_STOP=1','-At']
p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
p.stdin.write("begin; select public.confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)); select 'locked';\n");p.stdin.flush()
while p.stdout.readline().strip()!='locked': pass
for sql in ["delete from forms_pilot_approved_sites", "update websites set owner_id='55555555-5555-5555-5555-555555555555'"]:
 r=subprocess.run(base,input="set lock_timeout='200ms'; "+sql+';',text=True,capture_output=True)
 assert r.returncode!=0 and 'lock timeout' in r.stderr,r
 print('PASS confirmation transaction blocks '+sql.split()[0])
p.stdin.write('rollback;\n');p.stdin.close();assert p.wait()==0
