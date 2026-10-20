import hashlib,json,os,pathlib,signal,subprocess,time,urllib.request
os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
root=pathlib.Path('/opt/velon')
app=root/'app'
logs=root/'logs';logs.mkdir(exist_ok=True)
manifest=json.loads((root/'artifacts.json').read_text())
for artifact in manifest['artifacts']:
 if hashlib.sha256((root/'bin'/artifact['name']).read_bytes()).hexdigest()!=artifact['sha256']:
  raise SystemExit('Binary checksum mismatch: '+artifact['name'])
env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'],AGAVE_BIN=str(root/'bin'),CATALOGER_DIR=str(root/'cataloger'),LOCAL_RPC_PORT='19099',RPC_URL='http://127.0.0.1:19099',PUBLIC_RPC_URL='https://velon-eta.vercel.app/rpc',PUBLIC_DEMO_ORIGIN='https://velon-eta.vercel.app',LIVE_NETWORK='localnet',LIVE_CATALOG=str(app/'.data/local/catalog.json'),LIVE_TEST_BENCH='1',PORT='3400',RUNTIME_PORT='3401',MALLOC_ARENA_MAX='2',SOLANA_RAYON_THREADS='2',RAYON_NUM_THREADS='2',RUST_LOG='warn')
children=[]
def launch(args,name):
 with (logs/name).open('a') as log:
  p=subprocess.Popen(args,cwd=app,env=env,stdout=log,stderr=log,start_new_session=True)
 children.append(p)
 return p
def rpc(method):
 req=urllib.request.Request(env['RPC_URL'],json.dumps({'jsonrpc':'2.0','id':1,'method':method}).encode(),{'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=3) as r:return json.load(r)['result']
def stop(*_):raise KeyboardInterrupt
signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
try:
 catalog=app/'.data/local/catalog.json'
 if catalog.exists():
  launch([str(root/'bin/solana-test-validator'),'--quiet','--ledger',str(app/'.data/local/ledger'),'--rpc-port','19099','--faucet-port','20099','--limit-ledger-size','100000'],'validator.log')
 else:
  if (app/'.data/local/ledger').exists():raise RuntimeError('Incomplete bootstrap: preserve ledger for investigation')
  launch(['bun','scripts/host-local.ts'],'validator.log')
 for _ in range(300):
  if children[0].poll() is not None:raise RuntimeError('Validator exited')
  if catalog.exists():
   try:
    if rpc('getHealth')=='ok':break
   except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('Validator startup timed out')
 if rpc('getGenesisHash')!=json.loads(catalog.read_text())[0]['cluster']:raise RuntimeError('Catalog genesis mismatch')
 launch(['bun','scripts/host-demo.ts','--production'],'app.log')
 launch(['bun',str(root/'gateway.ts')],'gateway.log')
 print('Started verified local validator demo',flush=True)
 while True:
  if any(p.poll() is not None for p in children):raise RuntimeError('Demo process exited')
  time.sleep(3)
except KeyboardInterrupt:pass
finally:
 for p in children:
  if p.poll() is None:os.killpg(p.pid,signal.SIGINT)
 for p in children:
  try:p.wait(timeout=30)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL)
