#!/usr/bin/env python3
import json, math, random, threading, time, uuid, webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
LOCK = threading.Lock()

STATE = {
    "started_at": time.time(),
    "action": "stand",
    "seq": 0,
    "devices": [
        {"device_id":"EXO-001","model":"NY-EXO-A1","firmware_version":"demo-1.2.0","person_id":"P-001","online":True,"battery_pct":82,"source_type":"simulated"},
        {"device_id":"EXO-002","model":"NY-EXO-A1","firmware_version":"demo-1.2.0","person_id":"P-002","online":True,"battery_pct":74,"source_type":"simulated"},
        {"device_id":"EXO-003","model":"NY-EXO-P1","firmware_version":"demo-0.9.4","person_id":"P-003","online":True,"battery_pct":91,"source_type":"simulated"}
    ],
    "people": [
        {"person_id":"P-001","name":"演示人员A","skills":["搬运","装配"],"zone":"月台A","work_minutes":42,"risk_recent":0.20},
        {"person_id":"P-002","name":"演示人员B","skills":["搬运","拣选"],"zone":"月台B","work_minutes":25,"risk_recent":0.05},
        {"person_id":"P-003","name":"演示人员C","skills":["装配","巡检"],"zone":"工位1","work_minutes":68,"risk_recent":0.15}
    ],
    "history": [],
    "events": [],
    "last_event_at": 0,
}

ACTION = {
    "stand": {"pitch":3,"gyro":2,"load":0.12,"confidence":0.96,"label":"站立"},
    "walk": {"pitch":7,"gyro":38,"load":0.35,"confidence":0.93,"label":"行走"},
    "bend": {"pitch":46,"gyro":18,"load":0.52,"confidence":0.91,"label":"弯腰"},
    "lift": {"pitch":28,"gyro":29,"load":0.67,"confidence":0.89,"label":"搬举"},
    "high_load": {"pitch":34,"gyro":22,"load":0.91,"confidence":0.95,"label":"连续高负荷"},
    "abnormal": {"pitch":63,"gyro":115,"load":0.78,"confidence":0.88,"label":"剧烈异常"},
}

def now_iso():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")

def generate_sample():
    with LOCK:
        STATE["seq"] += 1
        cfg = ACTION.get(STATE["action"], ACTION["stand"])
        t = time.time() - STATE["started_at"]
        pitch = cfg["pitch"] + math.sin(t*2.2)*2 + random.uniform(-1.2,1.2)
        gyro = max(0,cfg["gyro"] + random.uniform(-5,5))
        load = min(1,max(0,cfg["load"] + random.uniform(-0.04,0.04)))
        fatigue = min(1,0.18 + t/2400 + load*0.35)
        sample = {
            "record_id": f"TS-{STATE['seq']:07d}",
            "device_id":"EXO-001",
            "timestamp":now_iso(),
            "seq":STATE["seq"],
            "source_type":"simulated",
            "telemetry":{"pitch_deg":round(pitch,1),"gyro_dps":round(gyro,1),"load_score":round(load,3),"fatigue_trend":round(fatigue,3),"assist_level":round(min(0.8,load*0.7),2)},
            "inference":{"label":cfg["label"],"code":STATE["action"],"confidence":round(cfg["confidence"]+random.uniform(-0.02,0.02),3),"model_id":"demo-rule-hybrid","model_version":"0.5.0"},
            "quality":{"status":"good","packet_loss_pct":0.1}
        }
        STATE["history"].append(sample)
        STATE["history"] = STATE["history"][-600:]
        if STATE["action"] in ("high_load","abnormal") and time.time()-STATE["last_event_at"]>8:
            code = "LOAD_CONTINUOUS" if STATE["action"]=="high_load" else "MOTION_ABNORMAL"
            sev = "L2"
            evt={"event_id":"EVT-"+uuid.uuid4().hex[:8].upper(),"event_code":code,"severity":sev,"status":"open","person_id":"P-001","device_id":"EXO-001","start_time":now_iso(),"trigger":{"type":"rule","rule_version":"risk-rule-v0.2","condition":"demo threshold"},"evidence":{"window_before_sec":30,"window_after_sec":30,"record_id":sample["record_id"],"data_quality":"good"},"source_type":"simulated"}
            STATE["events"].insert(0,evt); STATE["events"]=STATE["events"][:50]; STATE["last_event_at"]=time.time()
        return sample

def recommendation(payload):
    skill=payload.get("required_skill","搬运"); zone=payload.get("zone_id","月台A"); load=float(payload.get("load_level",0.5))
    rows=[]
    for p in STATE["people"]:
        skill_score=1 if skill in p["skills"] else 0
        zone_score=1 if p["zone"]==zone else 0.6
        work_score=max(0,1-p["work_minutes"]/120)
        risk_score=max(0,1-p["risk_recent"])
        capacity=max(0,1-load*0.3-p["risk_recent"])
        hard_block = skill_score==0
        total=30*skill_score+20*zone_score+20*capacity+15*work_score+15*risk_score
        rows.append({"person_id":p["person_id"],"name":p["name"],"eligible":not hard_block,"score":round(total,1),"reasons":{"技能匹配":round(30*skill_score,1),"区域接近":round(20*zone_score,1),"负荷余量":round(20*capacity,1),"作业时长余量":round(15*work_score,1),"近期风险余量":round(15*risk_score,1)}})
    return sorted(rows,key=lambda x:(x["eligible"],x["score"]),reverse=True)

def query_answer(q):
    q=q or ""
    if any(k in q for k in ["诊断","疾病","开除","降薪","保险"]):
        return {"answer":"该问题超出系统授权用途。平台不提供医学诊断，也不支持惩罚性绩效或保险定价。","evidence":[],"refused":True}
    hist=STATE["history"]
    if "负荷" in q or "最高" in q:
        if not hist: return {"answer":"当前没有可引用的本地记录。","evidence":[],"refused":True}
        s=max(hist[-120:],key=lambda x:x["telemetry"]["load_score"])
        return {"answer":f"过去本地记录中，演示人员A的最高负荷分数为 {s['telemetry']['load_score']:.2f}，动作判断为{s['inference']['label']}。该结果来自模拟数据，只用于演示工程闭环。","evidence":[{"record_id":s["record_id"],"timestamp":s["timestamp"],"model_version":s["inference"]["model_version"],"source_type":s["source_type"]}],"refused":False}
    if "事件" in q:
        ev=STATE["events"][:3]
        return {"answer":f"当前共有 {len(STATE['events'])} 条事件，最近事件代码为 {ev[0]['event_code'] if ev else '无'}。","evidence":[{"event_id":e["event_id"],"event_code":e["event_code"]} for e in ev],"refused":False}
    return {"answer":"我只能回答已接入本地结构化数据和事件的问题。可以询问“过去十分钟谁负荷最高”或“最近有什么事件”。","evidence":[],"refused":True}

def evaluate(payload):
    structured=float(payload.get("structured",4)); roi=float(payload.get("roi",3)); payer=float(payload.get("payer",3)); fit=float(payload.get("fit",4)); compliance=float(payload.get("compliance",4)); replicate=float(payload.get("replicate",3))
    score=structured*4+roi*4+payer*3+fit*3+compliance*3+replicate*3
    # max 100 when each 5
    rating="高" if score>=75 else "中" if score>=55 else "低"
    people=int(payload.get("people",20)); devices=max(2,round(people*0.35)); backups=max(1,math.ceil(devices*0.1))
    return {"score":round(score,1),"rating":rating,"recommended_devices":devices,"backup_devices":backups,"pilot_weeks":8 if rating=="高" else 10,"kpis":["特定工序作业时间","单位人力有效产出","负荷/疲劳趋势","设备连续运行与故障率","工人接受度","安全事件"],"conditions":["客户提供工序和基线数据","获得人员授权并签署DPA","现场完成安全评估","明确预算负责人和验收条件"],"source_type":"simulated_assessment"}

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self,path):
        parsed=urlparse(path).path
        if parsed.startswith('/api/'):
            return str(STATIC/'index.html')
        if parsed=='/': parsed='/index.html'
        return str(STATIC/parsed.lstrip('/'))
    def log_message(self,fmt,*args):
        print("[EWOH]",fmt%args)
    def send_json(self,obj,status=200):
        data=json.dumps(obj,ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(data))); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(data)
    def read_json(self):
        n=int(self.headers.get('Content-Length','0') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8') or '{}')
    def do_GET(self):
        p=urlparse(self.path).path
        if p=='/api/status':
            return self.send_json({"offline":True,"source_type":"simulated","services":{"gateway":"healthy","inference":"healthy","database":"healthy","assistant":"healthy"},"uptime_sec":round(time.time()-STATE["started_at"])})
        if p=='/api/devices': return self.send_json({"items":STATE["devices"]})
        if p=='/api/telemetry': return self.send_json(generate_sample())
        if p=='/api/events': return self.send_json({"items":STATE["events"]})
        if p=='/api/people': return self.send_json({"items":STATE["people"]})
        return super().do_GET()
    def do_POST(self):
        p=urlparse(self.path).path; payload=self.read_json()
        if p=='/api/simulate/action':
            action=payload.get('action','stand')
            if action not in ACTION: return self.send_json({"error":"invalid action"},400)
            STATE['action']=action; return self.send_json({"ok":True,"action":action})
        if p=='/api/tasks/recommend': return self.send_json({"items":recommendation(payload)})
        if p=='/api/query': return self.send_json(query_answer(payload.get('question','')))
        if p=='/api/scenario/evaluate': return self.send_json(evaluate(payload))
        if p=='/api/reset':
            with LOCK:
                STATE['action']='stand'; STATE['history']=[]; STATE['events']=[]; STATE['seq']=0; STATE['last_event_at']=0; STATE['started_at']=time.time()
            return self.send_json({"ok":True})
        return self.send_json({"error":"not found"},404)

def main():
    addr=('127.0.0.1',8765)
    print('EWOH Demo running at http://127.0.0.1:8765')
    print('Data source: SIMULATED. Do not present as customer or real-device validation.')
    try:
        threading.Timer(0.8,lambda:webbrowser.open('http://127.0.0.1:8765')).start()
    except Exception: pass
    ThreadingHTTPServer(addr,Handler).serve_forever()
if __name__=='__main__': main()
