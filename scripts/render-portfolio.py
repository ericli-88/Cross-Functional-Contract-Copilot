"""Create readable English Feishu-style portfolio figures from offline evidence.

Python 3.10+ and Pillow. All visible copy is English. No network access.
"""
from pathlib import Path
import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'docs/images'
OUT.mkdir(parents=True, exist_ok=True)
DATA = json.loads((ROOT/'docs/demo/portfolio.json').read_text('utf-8'))
FONT = os.environ.get('SCENE_FONT') or next((str(p) for p in [Path('C:/Windows/Fonts/segoeui.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), Path('/System/Library/Fonts/Helvetica.ttc')] if p.exists()), None)
BOLD = next((str(p) for p in [Path('C:/Windows/Fonts/segoeuib.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')] if p.exists()), FONT)
if not FONT: raise SystemExit('Set SCENE_FONT to an English UI font.')
W,H = 1680,1120
INK='#1c2b42'; MUTED='#69778c'; BLUE='#315efb'; BORDER='#dce3ee'; BG='#f3f6fc'
COLORS={'finance':'#147e69','operations':'#a16b12','commercial':'#315efb','legal':'#7750ad'}
FONTS={}
def ft(size,bold=False):
    key=(size,bold)
    if key not in FONTS: FONTS[key]=ImageFont.truetype(BOLD if bold else FONT,size)
    return FONTS[key]
def t(d,x,y,s,size=24,c=INK,b=False): d.text((x,y),str(s),font=ft(size,b),fill=c)
def box(d,xy,fill='white',r=12,border=None): d.rounded_rectangle(xy,radius=r,fill=fill,outline=border)
def wrap(d,s,width,size=24,b=False):
    rows=[]
    for para in s.split('\n'):
        row=''
        for word in para.split():
            trial=(row+' '+word).strip()
            if row and d.textlength(trial,font=ft(size,b))>width: rows.append(row);row=word
            else: row=trial
        rows.append(row)
    return rows
def body(d,x,y,s,width,size=24,c=INK,b=False,line=35):
    for row in wrap(d,s,width,size,b): t(d,x,y,row,size,c,b);y+=line
    return y
def pill(d,x,y,label,color=BLUE,bg='#eaf0ff',size=18):
    width=int(d.textlength(label,font=ft(size,True)))+30
    box(d,(x,y,x+width,y+34),bg,r=17)
    t(d,x+15,y+5,label,size,color,True)
    return width
def base(number,title,subtitle,conversation='Contract Review',private=False):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    t(d,40,24,f'{number:02d} / {title}',37,b=True)
    t(d,42,80,subtitle,23,MUTED)
    pill(d,1350,30,'SIMULATED DEMO',size=17)
    # A restrained Feishu-style desktop shell with a legible, dominant work area.
    box(d,(26,137,1654,1009),'white',r=15,border=BORDER)
    d.rectangle((27,180,1653,1008),fill='white')
    d.rectangle((27,180,108,1008),fill='#eaf0fa')
    t(d,48,151,'Feishu',18,BLUE,True)
    t(d,680,151,'Search conversations, documents, and tasks',17,MUTED)
    for i,label in enumerate(['A','Chat','Docs','Task']):
        yy=206+i*94
        if i==1:box(d,(37,yy-8,98,yy+49),'#dce6ff',r=9)
        t(d,43,yy,label,18,BLUE if i==1 else MUTED,True)
    d.rectangle((109,180,330,1008),fill='#f8faff')
    t(d,131,206,'Messages',24,b=True)
    for i,(name,preview) in enumerate([('Contract Review','Shared review workspace'),('Contract Copilot','Role-specific guidance'),('Delivery Team','Project coordination')]):
        yy=270+i*105
        selected=(private and i==1) or (not private and i==0)
        if selected:box(d,(119,yy-13,320,yy+69),'#e4ecff',r=8)
        t(d,132,yy,name,20,INK,True)
        t(d,132,yy+34,preview,13,MUTED)
    t(d,360,204,conversation,27,b=True)
    t(d,360,245,'Bot conversation' if private else 'Finance / Operations / Commercial / Legal',18,MUTED)
    d.line((331,283,1653,283),fill=BORDER)
    t(d,1505,215,'Search  ...',18,MUTED)
    d.line((331,951,1653,951),fill=BORDER)
    t(d,362,971,'Aa     Attach     @       Message',18,MUTED)
    pill(d,1510,964,'Send',size=17)
    t(d,42,1034,'English documentation view | Fictional contract and people | Offline adapters; no live messages',19,MUTED)
    t(d,42,1070,'Current runtime uses Chinese messages. These figures summarize verified workflow behavior.',18,MUTED)
    return im,d
def bot(d,y=310):
    box(d,(357,y,401,y+44),BLUE,r=11);t(d,369,y+6,'C',23,'white',True)
    t(d,418,y+3,'Contract Copilot',20,b=True);pill(d,598,y,'BOT',size=14)
def user(d,label):
    box(d,(650,308,1600,368),'#e8efff',r=11)
    t(d,673,324,label,22)
def card(d,x,y,w,h,title,color=BLUE):
    box(d,(x,y,x+w,y+h),'white',r=11,border=BORDER)
    box(d,(x,y,x+w,y+62),'#eaf0ff',r=11)
    d.rectangle((x+1,y+38,x+w-1,y+62),fill='#eaf0ff')
    t(d,x+23,y+15,title,24,color,True)
def save(im,name): im.save(OUT/(name+'.png'),optimize=True)

# 1. Make department-specific edits the first thing a reviewer sees.
im,d=base(1,'One contract. Four functional perspectives.','Actionable revision guidance, routed to the people who own each decision.')
bot(d,309)
card(d,357,365,1243,128,DATA['contract'])
t(d,380,446,'V1  |  Read the same source document  |  Return separate structured recommendations',22,MUTED)
ordered=sorted(DATA['roles'],key=lambda r:['finance','operations','commercial','legal'].index(r['key']))
for i,role in enumerate(ordered):
    x=357+(i%2)*630;y=511+(i//2)*205;c=COLORS[role['key']]
    box(d,(x,y,x+611,y+187),'#fbfcff',r=11,border=BORDER)
    d.rectangle((x+1,y+16,x+5,y+169),fill=c)
    t(d,x+23,y+14,role['name'],26,c,True)
    t(d,x+23,y+55,role['focus'],20,MUTED)
    body(d,x+23,y+90,role['action'],560,24,line=32)
save(im,'01-functional-review')

# 2. Show an actual link trigger and a concise group card, not a page of small text.
im,d=base(2,'Submit once. Share a review overview.','A document link in the group starts the first review; the source URL stays intact.')
user(d,'@Contract Copilot  https://example.feishu.cn/docx/DEMO_CONTRACT')
bot(d,394)
card(d,418,450,1182,432,'Review ready | '+DATA['contractId']+' | V1')
t(d,443,534,'Northstar Systems | Services Agreement',27,b=True)
t(d,443,582,'Submitted by Alex Morgan  /  First review',22,MUTED)
for i,label in enumerate(['Finance','Operations','Commercial','Legal']):
    yy=635+i*43
    t(d,446,yy,label,23,b=True)
    t(d,670,yy,'Needs revision' if label!='Legal' else 'High risk: liability terms',23,'#a16b12' if label!='Legal' else '#9b3535')
pill(d,443,830,'Open contract');pill(d,650,830,'Review archive')
save(im,'02-group-intake')

# 3. Center the finance recommendation and its owner; preserve the task-history boundary.
im,d=base(3,'Turn advice into accountable follow-up.','V1 sends each owner a task entry point. Later reviews update the same active task.','Contract Copilot',True)
bot(d,310)
card(d,418,367,1182,525,'Finance | V1 | Task entry point',COLORS['finance'])
t(d,444,448,'Owner: Jordan Lee',25,b=True)
t(d,444,494,'REVIEW FINDING',18,MUTED,True)
body(d,444,531,ordered[0]['risk'],1080,27,line=39)
t(d,444,629,'SUGGESTED CONTRACT REVISION',18,MUTED,True)
body(d,444,666,ordered[0]['action'],1080,28,line=40)
t(d,444,775,'Full role guidance is stored in the task comments.',23,MUTED)
pill(d,444,835,'Open task / history');pill(d,720,835,'Open contract')
save(im,'03-owner-guidance')

# 4. Show the branch in the workflow instead of visually identical V1/V2 cards.
im,d=base(4,'Review changes. Skip duplicate work.','Content hashing separates a true revision from a repeated submission.')
bot(d,313)
for yy,label,description,color in [(380,'V1 / First review','Create role tasks and send initial owner entry cards.',BLUE),(550,'Same content / No new version','Skip AI review, version creation, task updates, and owner DMs.','#147e69'),(720,'Changed content / V2','Append new advice to active task comments; reuse task identities.','#7750ad')]:
    box(d,(418,yy,1600,yy+144),'#fbfcff',r=12,border=BORDER)
    pill(d,445,yy+19,label,color,'#edf2ff',19)
    body(d,445,yy+74,description,1100,25,line=35)
save(im,'04-version-workflow')

# 5. Display actual completion behavior, not an invented persistent closed task.
im,d=base(5,'Human-controlled department status.','The bot records decisions; AI does not mark a department complete.')
bot(d,313)
card(d,418,378,1182,202,'Finance marked complete',COLORS['finance'])
body(d,444,464,'A configured owner confirms completion. Later reviews stop Finance task updates and owner reminders.',1095,26,line=38)
card(d,418,611,1182,215,'Finance reopened',BLUE)
body(d,444,699,'Status returns to active. The next changed-content review creates a replacement role task.',1095,26,line=38)
t(d,443,871,'Implementation detail: completion deletes the associated task; it does not archive it.',21,'#9b5b23')
save(im,'05-status-control')

# 6. Preserve the distinction between online documents and ordinary attachments.
im,d=base(6,'Two intake paths. Explicit boundaries.','Online documents support linked review; ordinary attachments support basic text extraction.')
bot(d,313)
for x,title,lines in [(357,'Online Feishu document',['docx / docs / wiki links','Keep the original URL','Role review + linked tasks','Shortcuts and docx snapshots']),(992,'Replied file attachment',['DOCX / TXT / Markdown / HTML','Basic support for text PDFs','Extract text for role review','No online conversion or contract link'])]:
    card(d,x,378,608,390,title)
    for i,line in enumerate(lines):body(d,x+25,466+i*62,line,554,24,line=32)
box(d,(357,801,1600,916),'#fff6e7',r=10)
body(d,382,821,'Not implemented: OCR for scanned files, automatic contract rewriting, or final approval. Legacy DOC files must be converted first.',1190,25,line=37)
save(im,'06-input-boundaries')

thumbs=[]
for p in sorted(OUT.glob('0[1-6]-*.png')):
    image=Image.open(p);image.thumbnail((840,560));thumbs.append(image.copy())
sheet=Image.new('RGB',(1680,560*((len(thumbs)+1)//2)),BG)
for i,image in enumerate(thumbs):sheet.paste(image,((i%2)*840,(i//2)*560))
sheet.save(OUT/'portfolio-contact-sheet.png')
print('Rendered six English portfolio figures with readable role-specific guidance.')
