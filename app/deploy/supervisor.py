import hashlib,json,os,pathlib,signal,subprocess,time,urllib.request
os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
root=pathlib.Path('/opt/velon')
app=root/'app'
logs=root/'logs';logs.mkdir(exist_ok=True)
manifest=json.loads((root/'artifacts.json').read_text())
for artifact in manifest['artifacts']:
 if hashlib.sha256((root/'bin'/artifact['name']).read_bytes()).hexdigest()!=artifact['sha256']:
  raise SystemExit('Binary checksum mismatch: '+artifact['name'])
origin=os.environ.get('PUBLIC_DEMO_ORIGIN','https://velon-eta.vercel.app')
network=os.environ.get('VELON_NETWORK','localnet')
if network not in ('localnet','mainnet'):raise SystemExit('VELON_NETWORK must be localnet or mainnet')
# The launchers run the checksummed binary and name the commit it was built from.
revision=manifest.get('revision','')
if len(revision)!=40:raise SystemExit('artifacts.json must name the 40-character revision the binary was built from')
env=dict(os.environ,PATH=str(root/'bin')+':'+os.environ['PATH'],CATALOGER_DIR=str(root/'cataloger'),AUTHZ_BIN=str(root/'bin/authorization-api'),CATALOGER_REVISION=revision,VELON_REVISION=revision,PUBLIC_RPC_URL=origin+'/rpc',PUBLIC_DEMO_ORIGIN=origin,LIVE_NETWORK=network,PORT='3400',RUNTIME_PORT='3401',MALLOC_ARENA_MAX='2',SOLANA_RAYON_THREADS='2',RAYON_NUM_THREADS='2',RUST_LOG='warn')
if network=='localnet':
 env.update(AGAVE_BIN=str(root/'bin'),LOCAL_RPC_PORT='19099',LOCAL_LEDGER_LIMIT='100000',RPC_URL='http://127.0.0.1:19099',LIVE_CATALOG=str(app/'.data/local/catalog.json'),LIVE_TEST_BENCH='1')
else:
 # The provider URL may carry a key; it stays in this process tree and never reaches a browser.
 upstream=os.environ.get('UPSTREAM_RPC_URL','')
 if not upstream.startswith('https://'):raise SystemExit('Mainnet mode needs UPSTREAM_RPC_URL over HTTPS')
 env.update(RPC_URL=upstream,MAINNET_RPC_URL=upstream)
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
def bench():
 catalog=app/'.data/local/catalog.json'
 if catalog.exists():
  launch([str(root/'bin/solana-test-validator'),'--quiet','--ledger',str(app/'.data/local/ledger'),'--rpc-port','19099','--faucet-port','20099','--limit-ledger-size','100000'],'validator.log')
 else:
  if (app/'.data/local/ledger').exists():raise RuntimeError('Incomplete bootstrap: preserve ledger for investigation')
  launch(['bun','scripts/local.ts'],'validator.log')
 for _ in range(300):
  if children[0].poll() is not None:raise RuntimeError('Validator exited')
  if catalog.exists():
   try:
    if rpc('getHealth')=='ok':break
   except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('Validator startup timed out')
 if rpc('getGenesisHash')!=json.loads(catalog.read_text())[0]['cluster']:raise RuntimeError('Catalog genesis mismatch')
try:
 if network=='localnet':bench()
 # Mainnet needs no validator; the demo captures the cluster's own code and features at launch.
 launch(['bun','scripts/demo.ts','--production'],'app.log')
 launch(['bun',str(app/'deploy/gateway.ts')],'gateway.log')
 # Started means the gateway answers its health check: app up and cluster reachable.
 for _ in range(600):
  if any(p.poll() is not None for p in children):raise RuntimeError('Demo process exited during startup')
  try:
   with urllib.request.urlopen('http://127.0.0.1:3402/healthz',timeout=3) as r:
    if r.status==200:break
  except Exception:pass
  time.sleep(1)
 else:raise RuntimeError('Demo did not become healthy')
 print('Started verified '+network+' demo',flush=True)
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
