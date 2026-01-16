// ==========================================
// 核心設定與全域變數
// ==========================================
const CONFIG = {
  TRIGGER_SHEET_NAME: '觸發器管理',
  // 請填入您想要固定更新的 Google Form ID 
  FIXED_FORM_ID: 'YOUR_GOOGLE_FORM_ID_HERE',
  GEMINI_MODEL: 'gemini-2.5-flash' // 使用的模型版本
};

// ==========================================
// 1. Web App 入口
// ==========================================
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ==========================================
// 2. Gemini AI 生成模組 (Controller -> Prompt -> API)
// ==========================================

/**
 * [Controller] 協調者：接收前端請求，讀取文件，呼叫 AI，回傳 JSON 字串
 */
function callGeminiToGenerateJson(apiKey, topic, qCount, docUrl) {
  Logger.log(`[UI呼叫] Topic: ${topic}, DocUrl: ${docUrl}`);
  
  if (!apiKey) throw new Error("缺少 API Key");

  let contextMaterial = "";
  
  // 如果有文件網址，嘗試讀取內容
  if (docUrl) {
    try {
      contextMaterial = extractTextFromDoc(docUrl);
      Logger.log(`[文件讀取成功] 字數: ${contextMaterial.length}, 前50字: ${contextMaterial.substring(0, 50)}...`);
    } catch (e) {
      Logger.log(`[文件讀取失敗] 將降級為純主題出題。原因: ${e.message}`);
      // 這裡不拋出錯誤，而是讓它繼續執行，改用純主題出題
      contextMaterial = ""; 
    }
  }

  const finalPrompt = generateQuizPrompt_(topic, qCount, contextMaterial);
  return callGeminiApi_(apiKey, finalPrompt);
}

/**
 * [Prompt Builder] 根據是否有參考文件，組裝不同的提示詞
 */
function generateQuizPrompt_(topic, qCount, contextMaterial) {
  const count = qCount || 5;
  let instructions = "";

  // 策略判斷：是否有有效的文件內容 (RAG 模式 vs 自由發揮模式)
  if (contextMaterial && contextMaterial.length > 50) {
    instructions = `
      你現在是一個「嚴格的閱讀測驗出題機器」。
      
      【任務目標】：
      請根據下方【指定文章】，出一份 ${count} 題的單選題。
      
      【指定文章內容】：
      """
      ${contextMaterial}
      """
      
      【出題鐵律 (必須遵守)】：
      1. ⚠️ **絕對禁止** 使用任何文章以外的外部知識。即使你知道更多背景，也**不准寫出來**。
      2. 題目必須只能從文章裡的資訊找到答案。
      3. 如果使用者有提供主題關鍵字：「${topic || '無'}」，請優先出與該關鍵字相關的段落；但如果文章裡沒提到該關鍵字，請**忽略關鍵字**，直接針對文章重點出題。
      4. 選項 (Options) 必須包含一個正確答案和三個錯誤答案。
    `;
  } else {
    instructions = `
      你是一個專業教師。請根據主題「${topic}」運用你的專業知識，出 ${count} 題單選題。
    `;
  }

  // 組合最終 Prompt (含格式要求)
  return `
    ${instructions}

    【嚴格回傳格式 (JSON Only)】：
    1. 請直接回傳 JSON Array，不要 Markdown，不要前言後語。
    2. 語言：繁體中文 (台灣用語)。
    3. 結構範例：[{"question":"...","options":["..."],"answerIndex":0,"explanation":"...","points":1}]
  `;
}

/**
 * [API Caller] 發送請求至 Gemini 並清洗回傳資料
 */
function callGeminiApi_(apiKey, prompt) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, options);
    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code !== 200) throw new Error(`API 錯誤 (${code}): ${text}`);

    const data = JSON.parse(text);
    
    // 檢查候選內容
    if (!data.candidates || data.candidates.length === 0) {
       const blockReason = data.promptFeedback?.blockReason || "未知原因";
       throw new Error(`生成失敗：AI 回傳空內容或被阻擋 (${blockReason})`);
    }

    // 提取並清洗 JSON 字串
    let rawResult = data.candidates[0].content.parts[0].text;
    rawResult = rawResult.replace(/```json/g, "").replace(/```/g, "").trim();

    // 驗證格式
    try { JSON.parse(rawResult); } 
    catch (e) { throw new Error("AI 回傳的格式不是有效的 JSON，請重試"); }

    return rawResult;

  } catch (e) {
    Logger.log("Gemini API Error: " + e.message);
    throw e;
  }
}

/**
 * [Helper] 從 Google Docs 讀取純文字
 */
function extractTextFromDoc(urlOrId) {
  if (!urlOrId) return "";
  
  let fileId = urlOrId;
  const match = urlOrId.match(/[-\w]{25,}/);
  if (match) fileId = match[0];

  try {
    const doc = DocumentApp.openById(fileId);
    const text = doc.getBody().getText();
    if (text.length < 10) throw new Error("文件內容過少");
    return text;
  } catch (e) {
    throw new Error(`無法讀取文件 (請確認權限): ${e.message}`);
  }
}

// ==========================================
// 3. 表單生成與更新模組
// ==========================================

/**
 * 功能一：更新固定表單
 */
function updateFixedQuiz(jsonString) {
  const form = FormApp.openById(CONFIG.FIXED_FORM_ID);
  const data = JSON.parse(jsonString);
  
  generateFormItems(form, data);

  return JSON.stringify({ 
    url: form.getPublishedUrl(), 
    formId: CONFIG.FIXED_FORM_ID,
    updatedAt: new Date().toLocaleString(),
    totalQuestions: data.length
  });
}

/**
 * 功能二：建立新試卷
 */
function createQuizFromJson(jsonString, quizTitle) {
  const data = JSON.parse(jsonString);
  const form = FormApp.create(quizTitle || '自動產生測驗');
  
  generateFormItems(form, data);

  // 寫入 Sheet 紀錄
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. 寫入試卷列表
  const meta = ss.getSheetByName('試卷列表') || ss.insertSheet('試卷列表');
  if (meta.getLastRow() === 0) meta.appendRow(['試卷名稱','Form 連結','建立時間','Form ID']);
  meta.appendRow([quizTitle, form.getEditUrl(), new Date(), form.getId()]);

  // 2. 寫入觸發器管理 (預設狀態為 False)
  const trig = ss.getSheetByName(CONFIG.TRIGGER_SHEET_NAME) || ss.insertSheet(CONFIG.TRIGGER_SHEET_NAME);
  if (trig.getLastRow() === 0) trig.appendRow(['Form ID','試卷名稱','是否已安裝','最後操作時間','備註／錯誤']);
  trig.appendRow([form.getId(), quizTitle, false, '', '等待安裝觸發器']);

  return JSON.stringify({ 
    url: form.getPublishedUrl(), 
    formId: form.getId(),
    updatedAt: new Date().toLocaleString(),
    totalQuestions: data.length
  });
}

/**
 * [Core] 共用建題邏輯：清空舊題、建立新題、儲存答案對照表
 */
function generateFormItems(form, data) {
  // 設定基本屬性
  form.setIsQuiz(true)
      .setCollectEmail(true)
      .setPublishingSummary(true)
      .setConfirmationMessage('✅ 測驗完成！請查看下方分數與正解。');

  // 清空舊題目 (安全刪除)
  form.getItems().forEach(item => { try { form.deleteItem(item); } catch(e) {} });

  // 插入更新時間
  const updateText = `📅 更新時間：${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm')}`;
  form.addParagraphTextItem().setTitle(updateText);

  // 建題並建立答案對照表
  const answerMap = {}; 
  const filteredData = data.filter(q => !/電子郵件|email/i.test(q.question)); // 簡單過濾

  filteredData.forEach((q, i) => {
    const item = form.addMultipleChoiceItem();
    const questionText = `${i + 1}. ${q.question}`;
    
    item.setTitle(questionText)
        .setChoiceValues(q.options)
        .setChoices(q.options.map((opt, idx) => item.createChoice(opt, idx === q.answerIndex)))
        .setPoints(q.points || 1);

    if (q.explanation) {
      const okFb = FormApp.createFeedback().setText('✔ 正確！\n' + q.explanation).build();
      const ngFb = FormApp.createFeedback().setText('✘ 錯誤：\n' + q.explanation).build();
      item.setFeedbackForCorrect(okFb).setFeedbackForIncorrect(ngFb);
    }

    // 儲存答案 (Key: ItemID)
    answerMap[item.getId().toString()] = {
      q: questionText,
      a: q.options[q.answerIndex],
      exp: q.explanation || ''
    };
  });

  // 將對照表存入 Properties (用於閱卷)
  PropertiesService.getDocumentProperties().setProperty('map_' + form.getId(), JSON.stringify(answerMap));
  
  return form;
}

// ==========================================
// 4. 觸發器管理模組 (Sheet Menu & Install Logic)
// ==========================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('觸發器管理')
    .addItem('⏩ 安裝缺漏觸發器', 'installMissingTriggers')
    .addItem('⏪ 移除已選行觸發器', 'removeSelectedTriggers')
    .addSeparator()
    .addItem('🔄 重新掃描觸發器狀態', 'scanTriggersToSheet')
    .addToUi();
}

/**
 * 安裝單一表單的提交觸發器
 */
function installFormTrigger(formId) {
  try {
    // 檢查配額 (一般帳號上限 20 個)
    const currentTriggers = ScriptApp.getProjectTriggers();
    if (currentTriggers.length >= 20) throw new Error('觸發器已達上限 (20個)');

    const form = FormApp.openById(formId);
    
    // 檢查是否已安裝
    const exists = currentTriggers.some(t => 
      t.getHandlerFunction() === 'handleFormSubmit' && t.getTriggerSourceId() === formId
    );

    if (!exists) {
      ScriptApp.newTrigger('handleFormSubmit').forForm(form).onFormSubmit().create();
    }
    
    updateTriggerStatus(formId, true, '安裝成功');
  } catch (err) {
    updateTriggerStatus(formId, false, err.message);
    throw err;
  }
}

/**
 * 批次安裝 Sheet 中標記為未安裝的觸發器
 */
function installMissingTriggers() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.TRIGGER_SHEET_NAME);
  const data = sh.getDataRange().getValues();
  let successCount = 0;
  
  for (let r = 1; r < data.length; r++) {
    const [fid, name, installed] = data[r];
    if (fid && !installed) {
      try {
        installFormTrigger(fid);
        successCount++;
      } catch (e) {
        sh.getRange(r + 1, 5).setValue(e.message);
      }
    }
  }
  SpreadsheetApp.getUi().alert(`嘗試安裝完成，成功安裝 ${successCount} 個。`);
}

/**
 * 移除 Sheet 中選取行的觸發器
 */
function removeSelectedTriggers() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG.TRIGGER_SHEET_NAME);
  const sel = sh.getActiveRange();
  
  if (!sel) return SpreadsheetApp.getUi().alert('請先選取要移除的行');
  
  const startRow = sel.getRow();
  const idsToRemove = sh.getRange(startRow, 1, sel.getNumRows(), 1).getValues().flat();
  const allTriggers = ScriptApp.getProjectTriggers();
  let count = 0;

  idsToRemove.forEach((id, idx) => {
    if(!id) return;
    const triggers = allTriggers.filter(t => t.getTriggerSourceId() === id);
    triggers.forEach(t => { ScriptApp.deleteTrigger(t); count++; });
    
    sh.getRange(startRow + idx, 3).setValue(false);
    sh.getRange(startRow + idx, 5).setValue('已手動移除');
  });
  
  SpreadsheetApp.getUi().alert(`已移除 ${count} 個觸發器。`);
}

/**
 * 掃描專案現有觸發器並更新 Sheet 狀態
 */
function scanTriggersToSheet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.TRIGGER_SHEET_NAME);
  if(!sh) return;

  const currentTriggers = ScriptApp.getProjectTriggers();
  const installedMap = {};
  currentTriggers.forEach(t => {
    if (t.getHandlerFunction() === 'handleFormSubmit') installedMap[t.getTriggerSourceId()] = true;
  });

  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    const updates = ids.map(row => [!!installedMap[row[0]]]);
    sh.getRange(2, 3, updates.length, 1).setValues(updates);
  }
  SpreadsheetApp.getUi().alert(`掃描完成，系統內共有 ${currentTriggers.length} 個觸發器。`);
}

function updateTriggerStatus(formId, installed, note) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.TRIGGER_SHEET_NAME);
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(formId)) {
      sh.getRange(r + 1, 3).setValue(installed);
      sh.getRange(r + 1, 4).setValue(new Date());
      sh.getRange(r + 1, 5).setValue(note || '');
      break;
    }
  }
}

// ==========================================
// 5. 閱卷與紀錄模組 (Trigger Handler)
// ==========================================

function handleFormSubmit(e) {
  const ss = SpreadsheetApp.getActive();
  const logSheet = ss.getSheetByName('錯題紀錄') || ss.insertSheet('錯題紀錄');
  const recordSheet = ss.getSheetByName('測驗紀錄') || ss.insertSheet('測驗紀錄');

  // 初始化 Header
  if (logSheet.getLastRow() === 0) logSheet.appendRow(['回答時間','學生信箱','試卷名稱','題號','題目文字','學生答案','正確答案','解析']);
  if (recordSheet.getLastRow() === 0) recordSheet.appendRow(['測驗卷建立時間', '測驗時間', '題數', '科目別', '答對率', '答錯率', '未答率']);

  const resp = e.response;
  const sourceForm = e.source;
  const formId = sourceForm.getId();
  
  // 讀取答案對照表
  const propJson = PropertiesService.getDocumentProperties().getProperty('map_' + formId);
  const answerMap = propJson ? JSON.parse(propJson) : {};

  let correct = 0, wrong = 0, blank = 0, totalMCQ = 0;

  resp.getItemResponses().forEach((ir) => {
    const item = ir.getItem();
    if (item.getType() !== FormApp.ItemType.MULTIPLE_CHOICE) return;

    totalMCQ++;
    const meta = answerMap[item.getId().toString()];
    if (!meta) return;

    const studentAnswer = ir.getResponse();
    const correctAnswer = meta.a;
    const isBlank = (!studentAnswer || studentAnswer === '這題我不會');
    const isCorrect = (studentAnswer === correctAnswer);

    // 寫入錯題
    if (!isCorrect && !isBlank) {
       logSheet.appendRow([
        resp.getTimestamp(), resp.getRespondentEmail(), sourceForm.getTitle(),
        item.getIndex() + 1, meta.q, studentAnswer, correctAnswer, meta.exp
      ]);
    }

    if (isBlank) blank++;
    else if (isCorrect) correct++;
    else wrong++;
  });

  // 嘗試讀取更新時間
  let updatedAt = '未知';
  try {
    const firstTitle = sourceForm.getItems()[0].asParagraphTextItem().getTitle();
    if (firstTitle.includes('更新時間')) updatedAt = firstTitle.replace('📅 更新時間：', '').trim();
  } catch(_) {}

  // 寫入統計
  const toPercent = (val) => totalMCQ === 0 ? '0%' : Math.round((val / totalMCQ) * 100) + '%';
  recordSheet.appendRow([
    updatedAt,
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm'),
    totalMCQ,
    sourceForm.getTitle(),
    toPercent(correct),
    toPercent(wrong),
    toPercent(blank)
  ]);
}

// ==========================================
// 6. 工具與授權函式
// ==========================================

/**
 * 🛠️ 授權專用函數
 * 目的：一次性觸發 appsscript.json 中定義的所有權限範圍 (Scopes)。
 * 執行後會建立暫存檔案以取得權限，隨後自動刪除。
 */
function fixPermissions() {
  console.log("🚀 正在觸發完整授權流程...");
  
  // 1. 觸發連網權限 (script.external_request)
  UrlFetchApp.fetch("https://www.google.com");

  // 2. 觸發文件權限 (documents)
  const doc = DocumentApp.create('TempAuth_Doc');
  const docId = doc.getId();

  // 3. 觸發表單權限 (forms)
  const form = FormApp.create('TempAuth_Form');
  const formId = form.getId();

  // 4. 觸發試算表權限 (spreadsheets)
  const ss = SpreadsheetApp.create('TempAuth_Sheet');
  const ssId = ss.getId();

  // 5. 觸發雲端硬碟權限 (drive) - 並利用此權限刪除剛剛建立的垃圾檔案
  // 這樣使用者的 Drive 就不會留下一堆測試檔案
  DriveApp.getFileById(docId).setTrashed(true);
  DriveApp.getFileById(formId).setTrashed(true);
  DriveApp.getFileById(ssId).setTrashed(true);

  console.log("✅ 授權成功！所有權限已取得，且暫存檔案已清除。");
}