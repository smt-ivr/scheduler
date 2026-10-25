// דף הניהול נשמר כקובץ HTML נפרד; wrangler מייבא קבצי .html כטקסט.
import page from './admin.html';

/** base: נתיב הבסיס (למשל "/scheduler" או ""), מגיע מ-BASE_PATH ולא מהבקשה */
export const renderAdminPage = (base = '') => page.replace('__BASE_PATH__', base.replace(/[^A-Za-z0-9/_-]/g, ''));
