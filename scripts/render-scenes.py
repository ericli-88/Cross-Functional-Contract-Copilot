"""Render deterministic Feishu-style documentation scenes from real demo output.

Requires Python 3.10+, Pillow and a CJK font. No network or API keys used.
"""
from pathlib import Path
import json
import os
import re
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
FONT = os.environ.get("SCENE_FONT") or next((str(p) for p in [
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/System/Library/Fonts/PingFang.ttc"),
] if p.exists()), None)
if not FONT:
    raise SystemExit("Set SCENE_FONT to a Chinese font file.")

INK = "#1f2329"
MUTED = "#8f959e"
BLUE = "#3370ff"
BORDER = "#dee0e3"
W = 1800

def font(size):
    return ImageFont.truetype(FONT, size)

def plain(text):
    text = re.sub(r"<at id=([^>]+)></at>", lambda m: "@" + {"commercial_1":"林晓", "operations_1":"周宁", "legal_1":"陈悦", "finance_1":"许安"}.get(m[1], "负责人"), text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1 ↗", text)
    return text.replace("**", "").replace("`", "")

measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
def wrapped(text, width, size=22):
    lines = []
    for paragraph in plain(text).splitlines():
        if not paragraph:
            lines.append("")
            continue
        row = ""
        for char in paragraph:
            if row and measure.textlength(row + char, font=font(size)) > width:
                lines.append(row)
                row = char
            else:
                row += char
        lines.append(row)
    return lines

def text(draw, xy, value, size=22, fill=INK):
    draw.text(xy, str(value), font=font(size), fill=fill)

def box(draw, coords, fill, radius=12, outline=None):
    draw.rounded_rectangle(coords, radius=radius, fill=fill, outline=outline)

def avatar(draw, x, y, value, fill=BLUE, size=46):
    box(draw, (x, y, x+size, y+size), fill, radius=12)
    f = font(22)
    tw = draw.textlength(value, font=f)
    draw.text((x+(size-tw)/2, y+8), value, font=f, fill="white")

def multiline(draw, x, y, value, width, size=22, fill=INK, step=34):
    for line in wrapped(value, width, size):
        text(draw, (x,y), line, size, fill)
        y += step if line else step//2
    return y

def card_layout(card, width=1060):
    lines = []
    buttons = []
    for elem in card.get("elements", []):
        if elem["tag"] == "markdown":
            lines.extend(wrapped(elem["content"], width-56, 22))
        elif elem["tag"] == "action":
            buttons.extend(a["text"]["content"] for a in elem["actions"])
    height = 80 + sum(18 if not line else 34 for line in lines) + (82 if buttons else 28)
    return lines, buttons, height

notes = {
    "01-registration": "负责人可以在群里注册。生产部署建议用环境变量固定四职能负责人，并限制目标群。",
    "02-link-review": "同一个飞书在线文档保留原链接。四职能分别生成建议，群内汇总各部门状态和风险。",
    "03-private-task": "V1 私信对应负责人任务入口。详细建议写入飞书任务；卡片按钮均由实际格式化函数生成。",
    "04-no-change": "正文 hash 相同则跳过模型调用：不增版本、不重复建任务、不重复发送负责人私信。",
    "05-revision": "修改后再次提交同一文档，生成 V2 并复用原来的职能任务；完整建议追加到任务评论。",
    "06-task-history": "此图展示离线适配器记录的真实任务字段与评论摘录。每个职能沿用一个任务，版本建议持续保留。",
    "07-completed": "只有该职能负责人能确认完成。AI 不自动决定完成状态，后续版本跳过该职能的任务更新。",
    "08-reopened": "负责人恢复处理后，后续版本重新纳入该职能。群内状态卡和最近一张总览卡同步更新。",
    "09-attachment": "普通附件仅抽取可读文字，不转在线文档、不生成合同跳转链接；推荐使用飞书在线文档获得完整能力。",
    "10-archive": "在线文档在合同子文件夹中创建快捷方式，docx 生成版本快照；普通附件不自动生成在线文档。",
    "11-reset": "删除的是本地审查记录；同一文档下次按首次审查处理。不会删除原飞书文档。",
}

def render(scene, number):
    card = scene.get("card")
    content_h = card_layout(card)[2] if card else 540
    if scene["kind"] == "text":
        content_h = max(180, len(wrapped(scene.get("text", ""), 960))*34 + 55)
    if scene["kind"] in ("task", "archive"):
        content_h = 830
    H = max(1050, 445 + content_h + 360)
    im = Image.new("RGB", (W,H), "#edf0f5")
    d = ImageDraw.Draw(im)
    # Editorial title and an unmistakable simulation label outside the UI.
    text(d,(44,23),f"{number:02d}  /  {scene['title']}",31)
    box(d,(1420,22,1756,66),"#e4ecff",radius=22)
    text(d,(1444,30),"模拟飞书界面 · 虚构数据",20,BLUE)
    # Desktop application window.
    d.rectangle((24,92,W-24,H-133),fill="white")
    d.rectangle((24,92,W-24,140),fill="#f5f6f7")
    for i,c in enumerate(["#ff6058","#ffbd2d","#28c840"]):
        d.ellipse((43+i*25,108,56+i*25,121),fill=c)
    box(d,(595,100,1240,131),"#e9ebef",radius=6)
    text(d,(615,100),"搜索（⌘ K）",18,MUTED)
    text(d,(1680,99),"—  □  ×",18,MUTED)
    # Rail.
    d.rectangle((24,140,115,H-133),fill="#edf1f8")
    avatar(d,46,162,"林","#7187bc",46)
    for idx,(label,symbol) in enumerate([( "消息", "≡"),("日历","日"),("云文档","文"),("工作台","台"),("任务","✓")]):
        y = 244+idx*95
        if idx==0: box(d,(33,y-13,105,y+69),"#dbe7ff",radius=9)
        text(d,(59,y-5),symbol,27,BLUE if idx==0 else "#646a73")
        text(d,(43,y+35),label,17,BLUE if idx==0 else "#646a73")
    # Conversation list.
    d.rectangle((115,140,411,H-133),fill="#fafbfc")
    text(d,(140,164),"消息",29)
    text(d,(356,167),"＋",25,MUTED)
    text(d,(140,224),"全部  ▾       未读       @我",18,"#646a73")
    chats=[("合","合同审核协作群","合同审查机器人：[卡片消息]",BLUE), ("审","合同审查机器人","详细审查建议已写入对应任务","#4080ff"),("商","商务协作群","林晓：已更新交付清单","#7d67c7"),("团","项目团队","周宁：验收标准已补充","#33a78d")]
    for i,(symbol,name,preview,color) in enumerate(chats):
        y=270+i*96
        if (scene['kind']=="private" and i==1) or (scene['kind']!="private" and i==0):
            box(d,(123,y-7,402,y+78),"#e8efff",radius=8)
        avatar(d,137,y+7,symbol,color,43)
        text(d,(191,y+4),name,20)
        text(d,(191,y+38),preview[:12]+"…",16,MUTED)
    # Chat header.
    title = "合同审查机器人" if scene["kind"]=="private" else "合同审核协作群"
    text(d,(441,164),title,27)
    text(d,(441,205),"机器人  ·  应用消息" if scene['kind']=="private" else "5 位成员  ·  商务 / 运营 / 法务 / 财务",17,MUTED)
    text(d,(1583,172),"⌕    ☎    ···",24,"#646a73")
    d.line((412,242,W-24,242),fill=BORDER,width=1)
    text(d,(979,258),"今天  10:24",16,MUTED)
    # Human trigger bubble.
    if scene.get("userText") and scene["kind"] != "private":
        user = scene["userText"]
        rows=wrapped(user,1035,21)
        bh = len(rows)*31+25
        actor = "许" if scene['id'] in ("07-completed", "08-reopened") else "林"
        avatar(d,1691,298,actor,"#7187bc",43)
        box(d,(530,298,1670,298+bh),"#e1eaff",radius=10)
        multiline(d,551,307,user,1090,21,step=31)
        cy=298+bh+37
    else:
        cy=309
    avatar(d,442,cy,"审",BLUE,43)
    text(d,(500,cy-3),"合同审查机器人",18,"#646a73")
    box(d,(682,cy-2,744,cy+24),"#eff4ff",radius=4)
    text(d,(690,cy),"机器人",14,BLUE)
    y=cy+38
    if card:
        lines,buttons,ch=card_layout(card)
        x=500
        colors={"blue":("#e1eaff",BLUE),"green":("#e2f3e9","#237b4b"),"orange":("#fff0d5","#b06008"),"red":("#fce4e5","#bd3038")}
        bg,fg=colors[card["header"]["template"]]
        box(d,(x,y,x+1060,y+ch),"white",radius=10,outline=BORDER)
        box(d,(x,y,x+1060,y+65),bg,radius=10)
        d.rectangle((x+1,y+40,x+1059,y+65),fill=bg)
        text(d,(x+24,y+18),card['header']['title']['content'],24,fg)
        yy=y+83
        for line in lines:
            if line:
                color = BLUE if line.startswith("@") or "↗" in line else INK
                text(d,(x+25,yy),line,22,color)
                yy+=34
            else: yy+=18
        bx=x+24
        for i,label in enumerate(buttons):
            bw=int(d.textlength(label,font=font(20)))+36
            box(d,(bx,yy+14,bx+bw,yy+57),BLUE if i==0 else "white",radius=6,outline=BLUE if i==0 else BORDER)
            text(d,(bx+18,yy+22),label,20,"white" if i==0 else INK)
            bx+=bw+14
    elif scene["kind"] == "task":
        box(d,(500,y,1685,y+750),"white",radius=10,outline=BORDER)
        task=scene['task']
        yy=multiline(d,530,y+25,"○  "+task['summary'],1090,27,step=41)
        text(d,(530,yy+15),"负责人  许安       状态  进行中       来源  合同审查机器人",20,MUTED)
        d.line((530,yy+65,1650,yy+65),fill=BORDER)
        text(d,(530,yy+85),"任务评论 · 版本审查建议",23)
        yy+=140
        for i,comment in enumerate(scene['comments']):
            box(d,(530,yy,1655,yy+226),"#f7f8fa",radius=9)
            text(d,(550,yy+13),f"合同审查机器人  ·  V{i+1}",20,BLUE)
            excerpt="\n".join(plain(comment['content']).splitlines()[:6])
            multiline(d,550,yy+52,excerpt,1060,20,step=30)
            text(d,(550,yy+192),"… 评论内容摘录",17,MUTED)
            yy+=248
    elif scene["kind"] == "archive":
        box(d,(500,y,1685,y+720),"white",radius=10,outline=BORDER)
        text(d,(530,y+25),"云文档  /  合同  /  合同归档",27)
        text(d,(530,y+78),"名称                                                    类型",20,MUTED)
        yy=y+128
        rows=[("▣  合同", "本群共享文件夹")]
        rows += [("    ▣  "+f['name'], "合同子文件夹") for f in scene['folders'] if f['name']!="合同"]
        rows += [("        ↗  星河科技 · 软件服务合同（虚构）", "原文档快捷方式")]
        rows += [("        ◷  "+v['name'], "docx 版本快照") for v in scene['versions']]
        for label,kind in rows:
            d.line((530,yy-8,1650,yy-8),fill="#eef0f3")
            text(d,(535,yy+8),label,22)
            text(d,(1400,yy+10),kind,18,MUTED)
            yy+=73
        text(d,(533,yy+16),"在线文档：保留原链接；普通附件：基础文字审查。",21,BLUE)
    else:
        lines=wrapped(scene.get('text',''),1035,22)
        bh=sum(18 if not line else 34 for line in lines)+35
        box(d,(500,y,1595,y+bh),"#f1f2f4",radius=9)
        multiline(d,522,y+15,scene.get('text',''),1040,22)
    # Message composer, kept below the message content.
    composer=H-264
    d.line((412,composer,W-24,composer),fill=BORDER)
    text(d,(444,composer+13),"Aa    ☺    ＋    @    ⊞",23,MUTED)
    text(d,(444,composer+62),"发送给 "+title,21,"#b2b6bd")
    box(d,(1640,composer+70,1738,composer+109),"#e8efff",radius=6)
    text(d,(1664,composer+76),"发送",19,BLUE)
    text(d,(44,H-107),notes[scene['id']],22,"#444b58")
    text(d,(44,H-60),"演示说明：项目真实工作流与卡片输出 + 内存飞书适配器 + 固定 AI 样例；界面为模拟绘制，并非真实飞书截图。",18,MUTED)
    im.save(OUT/(scene['id']+".png"),optimize=True)
    return im

scenes=json.loads((ROOT/'docs/demo/scenes.json').read_text('utf-8'))['scenes']
thumbs=[]
for i,scene in enumerate(scenes,1):
    im=render(scene,i)
    im.thumbnail((600,500))
    thumbs.append(im)
contact=Image.new('RGB',(1800,550*((len(thumbs)+2)//3)),"#e8ebf0")
for i,im in enumerate(thumbs): contact.paste(im,((i%3)*600,(i//3)*550))
contact.save(OUT/'contact-sheet.png')
print(f"Rendered {len(scenes)} Feishu-style scenes into {OUT}")
