// In-memory Feishu adapter derived from workflow regression fixtures. No network calls.
export class DemoFeishu {
  textMessages = [];
  privateCards = [];
  groupCards = [];
  updatedMessages = [];
  messages = new Map();
  messageFiles = new Map();
  docxText = new Map();
  importedTextQueue = [];
  importedFiles = [];
  deletedFiles = [];
  createdFolders = [];
  chatFolderPermissions = [];
  tenantEditableTokens = [];
  shortcuts = [];
  documentVersions = [];
  createdTasks = [];
  updatedTasks = [];
  deletedTasks = [];
  taskComments = [];
  taskCompletion = new Map();

  async getChatName() {
    return "测试合同群";
  }

  async createFolder(name, parentFolderToken) {
    const folderToken = `folder_${this.createdFolders.length + 1}`;
    const record = {
      name,
      parentFolderToken,
      folderToken,
      folderUrl: `https://example.feishu.cn/drive/folder/${folderToken}`
    };
    this.createdFolders.push(record);
    return record;
  }

  async grantChatFolderFullAccess(folderToken, targetChatId) {
    this.chatFolderPermissions.push({ folderToken, chatId: targetChatId });
  }

  async importFileAsDocx(input) {
    const number = this.importedFiles.length + 1;
    const documentToken = `IMPORTED_${number}`;
    const documentUrl = `https://example.feishu.cn/docx/${documentToken}`;
    this.importedFiles.push({ ...input, documentToken, documentUrl });
    this.docxText.set(
      documentToken,
      this.importedTextQueue.shift() ?? `Imported contract ${number}`
    );
    return { documentToken, documentUrl };
  }

  async setTenantEditable(documentToken) {
    this.tenantEditableTokens.push(documentToken);
  }

  async deleteDriveFile(documentToken) {
    this.deletedFiles.push(documentToken);
  }

  async createDocumentShortcut(input) {
    this.shortcuts.push(input);
  }

  async createDocumentVersion(input) {
    const version = `snapshot-${this.documentVersions.length + 1}`;
    this.documentVersions.push({ ...input, version });
    return version;
  }

  async getDocxMetadata(documentToken) {
    return { title: `Contract ${documentToken}`, revisionId: 1 };
  }

  async getDocxRawContent(documentToken) {
    return this.docxText.get(documentToken) ?? "Default contract text.";
  }

  async getDocsContent(documentToken) {
    return { title: `Legacy ${documentToken}`, content: this.docxText.get(documentToken) };
  }

  async getWikiNodeInfo() {
    throw new Error("wiki is not used in this test");
  }

  async getMessage(messageId) {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`missing fake message ${messageId}`);
    return message;
  }

  async downloadMessageFile(messageId, fileKey) {
    const data = this.messageFiles.get(`${messageId}:${fileKey}`);
    if (!data) throw new Error(`missing fake file ${messageId}:${fileKey}`);
    return data;
  }

  async getUserDisplayName(userId) {
    const known = {
      commercial_1: "商务负责人1",
      operations_1: "运营负责人1",
      legal_1: "法务负责人1",
      finance_1: "财务负责人1"
    };
    return known[userId];
  }

  async getChatMemberDisplayName(_targetChatId, userId) {
    return this.getUserDisplayName(userId);
  }

  async createTask(input) {
    const roleKey = input.clientToken.split("-").at(-1);
    const taskGuid = `task-${roleKey}`;
    const taskUrl = `https://example.feishu.cn/task/${taskGuid}`;
    this.createdTasks.push({ ...input, taskGuid, taskUrl });
    this.taskCompletion.set(taskGuid, "0");
    return { taskGuid, taskUrl };
  }

  async updateTask(input) {
    this.updatedTasks.push(input);
    if (input.completedAt !== undefined) {
      this.taskCompletion.set(input.taskGuid, input.completedAt);
    }
  }

  async getTask(taskGuid) {
    return {
      completedAt: this.taskCompletion.get(taskGuid),
      taskUrl: `https://example.feishu.cn/task/${taskGuid}`
    };
  }

  async deleteTask(taskGuid) {
    this.deletedTasks.push(taskGuid);
    this.taskCompletion.delete(taskGuid);
  }

  async addTaskComment(taskGuid, content) {
    this.taskComments.push({ taskGuid, content });
  }

  async sendTextToChatId(targetChatId, text) {
    this.textMessages.push({ chatId: targetChatId, text });
    return {};
  }

  async sendInteractiveCardToChatId(targetChatId, card) {
    const messageId = `om_group_card_${this.groupCards.length + 1}`;
    this.groupCards.push({ chatId: targetChatId, card, messageId });
    return { messageId };
  }

  async sendInteractiveCardToUserId(userId, card) {
    const messageId = `om_private_card_${this.privateCards.length + 1}`;
    this.privateCards.push({ userId, card, messageId });
    return { messageId };
  }

  async updateInteractiveMessage(messageId, card) {
    this.updatedMessages.push({ messageId, card });
  }

  lastTextToChat() {
    return this.textMessages.at(-1)?.text ?? "";
  }
}
