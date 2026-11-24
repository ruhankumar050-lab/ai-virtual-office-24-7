const fs = require('node:fs');
const path = require('node:path');

const DRIVE_TOKEN_KV_KEY = 'google_drive_oauth_tokens';
const DRIVE_CONFIG_KV_KEY = 'google_drive_oauth_app';

class GoogleDriveIntegration {
  constructor(db) {
    this.db = db;
  }

  getOAuthCredentials() {
    const saved = this.db.getKV(DRIVE_CONFIG_KV_KEY, {}) || {};
    const clientId = process.env.GOOGLE_CLIENT_ID || saved.clientId || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || saved.clientSecret || '';
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || saved.redirectUri || '';
    return {
      clientId,
      clientSecret,
      redirectUri,
      configured: Boolean(clientId && clientSecret),
    };
  }

  saveOAuthAppCredentials({ clientId, clientSecret, redirectUri }) {
    const prev = this.db.getKV(DRIVE_CONFIG_KV_KEY, {}) || {};
    this.db.setKV(DRIVE_CONFIG_KV_KEY, {
      clientId: clientId ? clientId.trim() : prev.clientId || '',
      clientSecret: clientSecret ? clientSecret.trim() : prev.clientSecret || '',
      redirectUri: redirectUri ? redirectUri.trim() : prev.redirectUri || '',
    });
    this.db.logAudit('owner', 'configure_drive_oauth_app', 'google_drive', {
      hasClientId: Boolean(clientId || prev.clientId),
    });
  }

  getAuthUrl(fallbackRedirectUri) {
    const creds = this.getOAuthCredentials();
    if (!creds.configured) {
      throw new Error('لم يتم ضبط GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET بعد.');
    }
    const redirectUri = creds.redirectUri || fallbackRedirectUri;
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleOAuthCallback(code, fallbackRedirectUri) {
    const creds = this.getOAuthCredentials();
    if (!creds.configured) throw new Error('بيانات OAuth غير مضبوطة على الخادم.');
    const redirectUri = creds.redirectUri || fallbackRedirectUri;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`فشل تبادل رمز Google OAuth (${res.status}): ${txt.slice(0, 180)}`);
    }
    const tokenData = await res.json();
    const prev = this.db.getKV(DRIVE_TOKEN_KV_KEY, {}) || {};
    const stored = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || prev.refresh_token || '',
      expires_at: Date.now() + (Number(tokenData.expires_in) || 3500) * 1000,
      scope: tokenData.scope || '',
      connected_at: new Date().toISOString(),
    };
    this.db.setKV(DRIVE_TOKEN_KV_KEY, stored);
    const rootFolderId = await this.ensureRootFolder();
    this.db.logAudit('owner', 'connect_google_drive', 'google_drive', { rootFolderId });
    return { connected: true, rootFolderId };
  }

  disconnect() {
    this.db.setKV(DRIVE_TOKEN_KV_KEY, null);
    this.db.logAudit('owner', 'disconnect_google_drive', 'google_drive', {});
  }

  async ensureValidToken() {
    const stored = this.db.getKV(DRIVE_TOKEN_KV_KEY);
    if (!stored || !stored.access_token) {
      throw new Error('Google Drive غير مربوط بعد. اضغط "ربط Google Drive" أولاً.');
    }
    if (Date.now() < (stored.expires_at || 0) - 60000) {
      return stored.access_token;
    }
    if (!stored.refresh_token) {
      throw new Error('انتهت صلاحية جلسة Drive ولا يوجد refresh_token — يرجى إعادة الربط.');
    }
    const creds = this.getOAuthCredentials();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: stored.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      throw new Error('تعذر تحديث توكن Google Drive — يرجى إعادة تسجيل الدخول.');
    }
    const refreshed = await res.json();
    stored.access_token = refreshed.access_token;
    stored.expires_at = Date.now() + (Number(refreshed.expires_in) || 3500) * 1000;
    this.db.setKV(DRIVE_TOKEN_KV_KEY, stored);
    return stored.access_token;
  }

  async getAboutQuota() {
    const token = await this.ensureValidToken();
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Drive about HTTP ${res.status}`);
    return await res.json();
  }

  async ensureFolder(name, parentId = null) {
    const token = await this.ensureValidToken();
    const escaped = String(name).replace(/'/g, "\\'");
    const qParts = [`name='${escaped}'`, "mimeType='application/vnd.google-apps.folder'", 'trashed=false'];
    if (parentId) qParts.push(`'${parentId}' in parents`);
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(' and '))}&fields=files(id,name)`;
    const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (searchRes.ok) {
      const data = await searchRes.json();
      if (data.files && data.files[0]) return data.files[0].id;
    }

    const body = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    };
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) throw new Error(`Failed to create Drive folder ${name}`);
    const created = await createRes.json();
    return created.id;
  }

  async ensureRootFolder() {
    const folderId = await this.ensureFolder('AI Virtual Office');
    const stored = this.db.getKV(DRIVE_TOKEN_KV_KEY, {}) || {};
    stored.root_folder_id = folderId;
    this.db.setKV(DRIVE_TOKEN_KV_KEY, stored);
    return folderId;
  }

  async ensureProjectSubfolders(projectTitle, departmentLabel) {
    const rootId = await this.ensureRootFolder();
    const projectFolderId = await this.ensureFolder(projectTitle.slice(0, 80), rootId);
    const deptFolderId = await this.ensureFolder(departmentLabel.slice(0, 60), projectFolderId);
    return { rootId, projectFolderId, deptFolderId };
  }

  /**
   * Resumable upload with duplicate-overwrite protection
   */
  async uploadFile({ localPath, fileName, mimeType = 'application/octet-stream', folderId, allowOverwrite = false }) {
    if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);
    const token = await this.ensureValidToken();
    const targetFolderId = folderId || (await this.ensureRootFolder());
    const safeName = fileName || path.basename(localPath);

    if (!allowOverwrite) {
      const q = `name='${safeName.replace(/'/g, "\\'")}' and '${targetFolderId}' in parents and trashed=false`;
      const dupRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dupRes.ok) {
        const dup = await dupRes.json();
        if (dup.files && dup.files[0]) {
          // Create versioned copy instead of overwriting without permission
          const ext = path.extname(safeName);
          const base = path.basename(safeName, ext);
          return this.uploadFile({
            localPath,
            fileName: `${base}-${Date.now().toString(36)}${ext}`,
            mimeType,
            folderId: targetFolderId,
            allowOverwrite: true,
          });
        }
      }
    }

    const fileBuf = fs.readFileSync(localPath);
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileBuf.length),
      },
      body: JSON.stringify({
        name: safeName,
        parents: [targetFolderId],
      }),
    });
    if (!initRes.ok) throw new Error(`Drive resumable init HTTP ${initRes.status}`);
    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) throw new Error('Missing Drive resumable upload URL');

    // Chunked resumable upload (256KB aligned chunks for reliability)
    const CHUNK = 262144 * 4; // 1 MB
    let offset = 0;
    let finalMeta = null;
    while (offset < fileBuf.length) {
      const end = Math.min(offset + CHUNK, fileBuf.length);
      const slice = fileBuf.subarray(offset, end);
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${offset}-${end - 1}/${fileBuf.length}`,
        },
        body: slice,
      });
      if (putRes.status === 308) {
        offset = end;
        continue;
      }
      if (!putRes.ok) throw new Error(`Drive chunk upload failed HTTP ${putRes.status}`);
      finalMeta = await putRes.json();
      break;
    }

    return {
      id: finalMeta?.id || '',
      name: finalMeta?.name || safeName,
      webViewLink: finalMeta?.webViewLink || (finalMeta?.id ? `https://drive.google.com/file/d/${finalMeta.id}/view` : ''),
      size: fileBuf.length,
    };
  }

  async listFiles(query = '') {
    const stored = this.db.getKV(DRIVE_TOKEN_KV_KEY);
    if (!stored || !stored.access_token) return { connected: false, files: [] };
    const token = await this.ensureValidToken();
    const qParts = ['trashed=false'];
    if (query) qParts.push(`name contains '${String(query).replace(/'/g, "\\'")}'`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qParts.join(' and '))}&pageSize=30&orderBy=modifiedTime desc&fields=files(id,name,mimeType,size,modifiedTime,webViewLink,parents)`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive list HTTP ${res.status}`);
    const data = await res.json();
    return { connected: true, files: data.files || [] };
  }

  async getStatus() {
    const creds = this.getOAuthCredentials();
    const stored = this.db.getKV(DRIVE_TOKEN_KV_KEY);
    const connected = Boolean(stored && stored.access_token);
    const base = {
      oauthConfigured: creds.configured,
      hasClientId: Boolean(creds.clientId),
      hasClientSecret: Boolean(creds.clientSecret),
      redirectUri: creds.redirectUri,
      connected,
      rootFolderName: 'AI Virtual Office',
      rootFolderId: stored?.root_folder_id || '',
      sharedQuotaNotice: 'تذكير: مساحة Google المجانية (عادةً 15 GB) مشتركة مع Gmail و Google Photos وليست منفصلة لـ Drive وحده.',
    };
    if (!connected) return base;
    try {
      const about = await this.getAboutQuota();
      return {
        ...base,
        user: about.user || null,
        storageQuota: about.storageQuota || null,
      };
    } catch (err) {
      return {
        ...base,
        error: err.message,
      };
    }
  }
}

module.exports = { GoogleDriveIntegration };
