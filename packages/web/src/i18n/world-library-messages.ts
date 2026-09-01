import type { UiLocale } from '@dsh-cyber/contracts'

import { registerMessages } from './runtime.js'

const LOCALES = [
  'zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES',
  'fr-FR', 'de-DE', 'pt-BR', 'ru-RU', 'ar-SA', 'hi-IN',
] as const satisfies readonly UiLocale[]

type LocaleValues = readonly [string, string, string, string, string, string, string, string, string, string, string, string]

/**
 * World library copy: the active list, the archive view and the permanent
 * delete gate. Values are ordered by LOCALES above.
 */
const messages = {
  'worldLibrary.open': ['管理世界', '管理世界', 'Manage worlds', 'ワールドを管理', '세계 관리', 'Gestionar mundos', 'Gérer les mondes', 'Welten verwalten', 'Gerenciar mundos', 'Управление мирами', 'إدارة العوالم', 'दुनिया प्रबंधित करें'],
  'worldLibrary.openHint': ['归档、恢复或永久删除世界', '封存、復原或永久刪除世界', 'Archive, restore or permanently delete worlds', 'ワールドのアーカイブ・復元・完全削除', '세계 보관, 복원 또는 영구 삭제', 'Archiva, restaura o elimina mundos', 'Archiver, restaurer ou supprimer des mondes', 'Welten archivieren, wiederherstellen oder löschen', 'Arquive, restaure ou exclua mundos', 'Архивирование, восстановление и удаление миров', 'أرشفة العوالم أو استعادتها أو حذفها', 'दुनिया संग्रहित, पुनर्स्थापित या हटाएँ'],
  'worldLibrary.title': ['世界库', '世界庫', 'World library', 'ワールドライブラリ', '세계 라이브러리', 'Biblioteca de mundos', 'Bibliothèque de mondes', 'Weltbibliothek', 'Biblioteca de mundos', 'Библиотека миров', 'مكتبة العوالم', 'दुनिया लाइब्रेरी'],
  'worldLibrary.subtitle': [
    '归档不会删除任何内容，随时可以恢复；永久删除无法撤销。',
    '封存不會刪除任何內容，隨時可以復原；永久刪除無法復原。',
    'Archiving deletes nothing and can be undone at any time. Permanent deletion cannot.',
    'アーカイブは何も削除せず、いつでも元に戻せます。完全削除は取り消せません。',
    '보관은 아무것도 삭제하지 않으며 언제든 되돌릴 수 있습니다. 영구 삭제는 되돌릴 수 없습니다.',
    'Archivar no borra nada y se puede deshacer en cualquier momento. La eliminación permanente no.',
    'L’archivage ne supprime rien et reste réversible à tout moment. La suppression définitive, non.',
    'Archivieren löscht nichts und lässt sich jederzeit rückgängig machen. Endgültiges Löschen nicht.',
    'Arquivar não apaga nada e pode ser desfeito a qualquer momento. A exclusão permanente, não.',
    'Архивирование ничего не удаляет и обратимо в любой момент. Безвозвратное удаление — нет.',
    'الأرشفة لا تحذف شيئًا ويمكن التراجع عنها في أي وقت، أما الحذف النهائي فلا.',
    'संग्रह कुछ भी नहीं मिटाता और कभी भी वापस लिया जा सकता है; स्थायी विलोपन नहीं।',
  ],
  'worldLibrary.close': ['关闭世界库', '關閉世界庫', 'Close the world library', 'ワールドライブラリを閉じる', '세계 라이브러리 닫기', 'Cerrar la biblioteca de mundos', 'Fermer la bibliothèque de mondes', 'Weltbibliothek schließen', 'Fechar a biblioteca de mundos', 'Закрыть библиотеку миров', 'إغلاق مكتبة العوالم', 'दुनिया लाइब्रेरी बंद करें'],
  'worldLibrary.tabs': ['世界库分栏', '世界庫分頁', 'World library views', 'ワールドライブラリの表示切替', '세계 라이브러리 보기', 'Vistas de la biblioteca de mundos', 'Vues de la bibliothèque de mondes', 'Ansichten der Weltbibliothek', 'Visões da biblioteca de mundos', 'Разделы библиотеки миров', 'أقسام مكتبة العوالم', 'दुनिया लाइब्रेरी दृश्य'],
  'worldLibrary.tabActive': ['我的世界', '我的世界', 'My worlds', 'マイワールド', '내 세계', 'Mis mundos', 'Mes mondes', 'Meine Welten', 'Meus mundos', 'Мои миры', 'عوالمي', 'मेरी दुनिया'],
  'worldLibrary.tabArchived': ['归档世界', '封存世界', 'Archived worlds', 'アーカイブ済みワールド', '보관된 세계', 'Mundos archivados', 'Mondes archivés', 'Archivierte Welten', 'Mundos arquivados', 'Архивные миры', 'العوالم المؤرشفة', 'संग्रहित दुनिया'],
  'worldLibrary.loading': ['正在读取世界列表…', '正在讀取世界清單…', 'Loading worlds…', 'ワールドを読み込み中…', '세계 목록을 불러오는 중…', 'Cargando mundos…', 'Chargement des mondes…', 'Welten werden geladen…', 'Carregando mundos…', 'Загрузка миров…', 'جارٍ تحميل العوالم…', 'दुनिया लोड हो रही हैं…'],
  'worldLibrary.loadError': ['无法读取世界列表，请稍后重试。', '無法讀取世界清單，請稍後再試。', 'The world list could not be loaded. Please try again.', 'ワールド一覧を読み込めませんでした。もう一度お試しください。', '세계 목록을 불러오지 못했습니다. 다시 시도해 주세요.', 'No se pudo cargar la lista de mundos. Inténtalo de nuevo.', 'La liste des mondes n’a pas pu être chargée. Veuillez réessayer.', 'Die Weltliste konnte nicht geladen werden. Bitte erneut versuchen.', 'Não foi possível carregar a lista de mundos. Tente novamente.', 'Не удалось загрузить список миров. Повторите попытку.', 'تعذّر تحميل قائمة العوالم. يُرجى المحاولة مرة أخرى.', 'दुनिया की सूची लोड नहीं हो सकी। कृपया फिर से प्रयास करें।'],
  'worldLibrary.emptyActive': ['还没有活跃的世界。', '還沒有使用中的世界。', 'There are no active worlds yet.', 'アクティブなワールドはまだありません。', '아직 활성 세계가 없습니다.', 'Todavía no hay mundos activos.', 'Aucun monde actif pour le moment.', 'Es gibt noch keine aktiven Welten.', 'Ainda não há mundos ativos.', 'Активных миров пока нет.', 'لا توجد عوالم نشطة بعد.', 'अभी कोई सक्रिय दुनिया नहीं है।'],
  'worldLibrary.emptyArchived': ['归档里还没有世界。', '封存中還沒有世界。', 'The archive is empty.', 'アーカイブにはまだワールドがありません。', '보관함에 세계가 없습니다.', 'El archivo está vacío.', 'L’archive est vide.', 'Das Archiv ist leer.', 'O arquivo está vazio.', 'В архиве пока нет миров.', 'الأرشيف فارغ.', 'संग्रह अभी खाली है।'],
  'worldLibrary.current': ['当前世界', '目前世界', 'Current world', '現在のワールド', '현재 세계', 'Mundo actual', 'Monde actuel', 'Aktuelle Welt', 'Mundo atual', 'Текущий мир', 'العالم الحالي', 'वर्तमान दुनिया'],
  'worldLibrary.createdAt': ['创建于 {date}', '建立於 {date}', 'Created {date}', '作成日 {date}', '{date} 생성', 'Creado el {date}', 'Créé le {date}', 'Erstellt am {date}', 'Criado em {date}', 'Создан {date}', 'أُنشئ في {date}', '{date} को बनाया गया'],
  'worldLibrary.archive': ['归档', '封存', 'Archive', 'アーカイブ', '보관', 'Archivar', 'Archiver', 'Archivieren', 'Arquivar', 'В архив', 'أرشفة', 'संग्रह करें'],
  'worldLibrary.restore': ['恢复', '復原', 'Restore', '復元', '복원', 'Restaurar', 'Restaurer', 'Wiederherstellen', 'Restaurar', 'Восстановить', 'استعادة', 'पुनर्स्थापित करें'],
  'worldLibrary.delete': ['永久删除', '永久刪除', 'Delete permanently', '完全に削除', '영구 삭제', 'Eliminar definitivamente', 'Supprimer définitivement', 'Endgültig löschen', 'Excluir permanentemente', 'Удалить навсегда', 'حذف نهائي', 'स्थायी रूप से हटाएँ'],
  'worldLibrary.deleting': ['正在删除…', '正在刪除…', 'Deleting…', '削除中…', '삭제하는 중…', 'Eliminando…', 'Suppression…', 'Wird gelöscht…', 'Excluindo…', 'Удаление…', 'جارٍ الحذف…', 'हटाया जा रहा है…'],
  'worldLibrary.cancel': ['取消', '取消', 'Cancel', 'キャンセル', '취소', 'Cancelar', 'Annuler', 'Abbrechen', 'Cancelar', 'Отмена', 'إلغاء', 'रद्द करें'],
  'worldLibrary.archived': [
    '「{name}」已归档，不再出现在世界列表里。',
    '「{name}」已封存，不再出現在世界清單中。',
    '“{name}” is archived and no longer appears in the world list.',
    '「{name}」をアーカイブしました。ワールド一覧には表示されません。',
    '‘{name}’을(를) 보관했습니다. 세계 목록에는 더 이상 표시되지 않습니다.',
    '«{name}» está archivado y ya no aparece en la lista de mundos.',
    '« {name} » est archivé et n’apparaît plus dans la liste des mondes.',
    '„{name}“ ist archiviert und erscheint nicht mehr in der Weltliste.',
    '“{name}” foi arquivado e não aparece mais na lista de mundos.',
    '«{name}» перемещён в архив и больше не показывается в списке миров.',
    'تمت أرشفة «{name}» ولم يعد يظهر في قائمة العوالم.',
    '“{name}” संग्रहित है और अब दुनिया की सूची में नहीं दिखेगा।',
  ],
  'worldLibrary.restored': ['「{name}」已恢复。', '「{name}」已復原。', '“{name}” is back in your world list.', '「{name}」を復元しました。', '‘{name}’을(를) 복원했습니다.', '«{name}» se ha restaurado.', '« {name} » a été restauré.', '„{name}“ wurde wiederhergestellt.', '“{name}” foi restaurado.', '«{name}» восстановлен.', 'تمت استعادة «{name}».', '“{name}” पुनर्स्थापित हो गया।'],
  'worldLibrary.deleted': ['「{name}」已永久删除。', '「{name}」已永久刪除。', '“{name}” was permanently deleted.', '「{name}」を完全に削除しました。', '‘{name}’을(를) 영구 삭제했습니다.', '«{name}» se eliminó definitivamente.', '« {name} » a été supprimé définitivement.', '„{name}“ wurde endgültig gelöscht.', '“{name}” foi excluído permanentemente.', '«{name}» удалён навсегда.', 'تم حذف «{name}» نهائيًا.', '“{name}” स्थायी रूप से हटा दिया गया।'],
  'worldLibrary.deleteTitle': ['永久删除「{name}」', '永久刪除「{name}」', 'Permanently delete “{name}”', '「{name}」を完全に削除', '‘{name}’ 영구 삭제', 'Eliminar definitivamente «{name}»', 'Supprimer définitivement « {name} »', '„{name}“ endgültig löschen', 'Excluir permanentemente “{name}”', 'Удалить «{name}» навсегда', 'حذف «{name}» نهائيًا', '“{name}” को स्थायी रूप से हटाएँ'],
  'worldLibrary.deleteWarning': [
    '这个世界的角色、会话、知识和文件都会被永久删除，无法恢复。',
    '這個世界的角色、對話、知識與檔案都會被永久刪除，無法復原。',
    'Every character, conversation, knowledge entry and file in this world is deleted for good.',
    'このワールドのキャラクター、会話、ナレッジ、ファイルはすべて完全に削除され、元に戻せません。',
    '이 세계의 캐릭터, 대화, 지식과 파일이 모두 영구히 삭제되며 되돌릴 수 없습니다.',
    'Se eliminarán para siempre todos los personajes, conversaciones, conocimientos y archivos de este mundo.',
    'Tous les personnages, conversations, connaissances et fichiers de ce monde seront supprimés définitivement.',
    'Alle Charaktere, Unterhaltungen, Wissenseinträge und Dateien dieser Welt werden unwiderruflich gelöscht.',
    'Todos os personagens, conversas, conhecimentos e arquivos deste mundo serão apagados para sempre.',
    'Все персонажи, диалоги, знания и файлы этого мира будут удалены безвозвратно.',
    'ستُحذف نهائيًا جميع الشخصيات والمحادثات والمعارف والملفات في هذا العالم.',
    'इस दुनिया के सभी किरदार, बातचीत, ज्ञान और फ़ाइलें हमेशा के लिए मिट जाएँगी।',
  ],
  'worldLibrary.deletePrompt': [
    '请准确输入世界名称「{name}」以确认',
    '請準確輸入世界名稱「{name}」以確認',
    'Type the world name “{name}” exactly to confirm',
    '確認のためワールド名「{name}」を正確に入力してください',
    '확인을 위해 세계 이름 ‘{name}’을(를) 정확히 입력하세요',
    'Escribe el nombre del mundo «{name}» exactamente para confirmar',
    'Saisissez exactement le nom du monde « {name} » pour confirmer',
    'Geben Sie zur Bestätigung genau den Weltnamen „{name}“ ein',
    'Digite exatamente o nome do mundo “{name}” para confirmar',
    'Введите название мира «{name}» в точности, чтобы подтвердить',
    'اكتب اسم العالم «{name}» بدقة للتأكيد',
    'पुष्टि के लिए दुनिया का नाम “{name}” बिलकुल वैसा ही टाइप करें',
  ],
  'worldLibrary.deleteReady': ['名称一致，可以永久删除。', '名稱一致，可以永久刪除。', 'The name matches. Permanent deletion is unlocked.', '名前が一致しました。完全に削除できます。', '이름이 일치합니다. 영구 삭제할 수 있습니다.', 'El nombre coincide. Ya puedes eliminarlo.', 'Le nom correspond. La suppression est déverrouillée.', 'Der Name stimmt. Löschen ist jetzt möglich.', 'O nome confere. A exclusão está liberada.', 'Название совпадает. Удаление разблокировано.', 'الاسم مطابق، ويمكنك الحذف الآن.', 'नाम मेल खाता है, अब स्थायी विलोपन संभव है।'],
  'worldLibrary.deleteMismatch': ['名称还不一致，完全一致后才能删除。', '名稱還不一致，完全一致後才能刪除。', 'The name does not match yet. Deletion stays locked until it matches exactly.', 'まだ名前が一致していません。完全に一致するまで削除できません。', '아직 이름이 일치하지 않습니다. 완전히 일치해야 삭제할 수 있습니다.', 'El nombre aún no coincide. No podrás eliminarlo hasta que sea idéntico.', 'Le nom ne correspond pas encore. La suppression reste bloquée.', 'Der Name stimmt noch nicht. Löschen bleibt gesperrt.', 'O nome ainda não confere. A exclusão continua bloqueada.', 'Название пока не совпадает. Удаление недоступно.', 'الاسم غير مطابق بعد، ويظل الحذف معطلًا.', 'नाम अभी मेल नहीं खाता, तब तक विलोपन बंद रहेगा।'],
  'worldLibrary.deleteBlocked': [
    '这个世界还有进行中的任务或角色运行，暂时不能删除。请先停止它们，或等它们结束后再试。',
    '這個世界還有進行中的任務或角色執行，暫時不能刪除。請先停止它們，或等它們結束後再試。',
    'This world still has work running. Stop the running tasks and character runs, or wait for them to finish, then delete it.',
    'このワールドではまだ処理が実行中です。実行中のタスクとキャラクターの実行を停止するか、終了を待ってから削除してください。',
    '이 세계에서 아직 작업이 실행 중입니다. 진행 중인 작업과 캐릭터 실행을 멈추거나 끝날 때까지 기다린 뒤 삭제하세요.',
    'Este mundo todavía tiene trabajo en curso. Detén las tareas y ejecuciones de personajes, o espera a que terminen, y vuelve a intentarlo.',
    'Ce monde a encore des traitements en cours. Arrêtez les tâches et exécutions de personnages, ou attendez la fin, puis réessayez.',
    'In dieser Welt läuft noch Arbeit. Stoppen Sie laufende Aufgaben und Charakterläufe oder warten Sie deren Ende ab, und löschen Sie dann.',
    'Este mundo ainda tem trabalho em andamento. Pare as tarefas e execuções de personagens, ou aguarde o término, e tente de novo.',
    'В этом мире ещё выполняется работа. Остановите активные задачи и запуски персонажей или дождитесь их завершения, затем повторите.',
    'لا تزال هناك أعمال قيد التنفيذ في هذا العالم. أوقف المهام وعمليات تشغيل الشخصيات الجارية أو انتظر انتهاءها ثم أعد المحاولة.',
    'इस दुनिया में अभी काम चल रहा है। चल रहे कार्य और किरदार रन रोकें, या उनके पूरा होने की प्रतीक्षा करें, फिर हटाएँ।',
  ],
  'worldLibrary.deleteNameMismatch': ['世界名称输入不一致，请重新输入完全一致的名称。', '世界名稱輸入不一致，請重新輸入完全一致的名稱。', 'The name you typed does not match. Enter it exactly as shown.', '入力されたワールド名が一致しません。表示どおりに正確に入力してください。', '입력한 세계 이름이 일치하지 않습니다. 표시된 대로 정확히 입력하세요.', 'El nombre que escribiste no coincide. Escríbelo exactamente igual.', 'Le nom saisi ne correspond pas. Saisissez-le exactement.', 'Der eingegebene Name stimmt nicht. Bitte exakt so eingeben.', 'O nome digitado não confere. Digite exatamente como mostrado.', 'Введённое название не совпадает. Введите его в точности.', 'الاسم الذي أدخلته غير مطابق. أدخله تمامًا كما هو معروض.', 'आपने जो नाम टाइप किया वह मेल नहीं खाता। उसे बिलकुल वैसा ही लिखें।'],
  'worldLibrary.alreadyArchived': ['这个世界已经归档了。', '這個世界已經封存了。', 'This world is already archived.', 'このワールドはすでにアーカイブ済みです。', '이 세계는 이미 보관되어 있습니다.', 'Este mundo ya está archivado.', 'Ce monde est déjà archivé.', 'Diese Welt ist bereits archiviert.', 'Este mundo já está arquivado.', 'Этот мир уже в архиве.', 'هذا العالم مؤرشف بالفعل.', 'यह दुनिया पहले से संग्रहित है।'],
  'worldLibrary.notArchived': ['这个世界没有归档，无需恢复。', '這個世界沒有封存，不需要復原。', 'This world is not archived, so there is nothing to restore.', 'このワールドはアーカイブされていないため、復元は不要です。', '이 세계는 보관되지 않아 복원할 필요가 없습니다.', 'Este mundo no está archivado, no hay nada que restaurar.', 'Ce monde n’est pas archivé, il n’y a rien à restaurer.', 'Diese Welt ist nicht archiviert, es gibt nichts wiederherzustellen.', 'Este mundo não está arquivado, não há o que restaurar.', 'Этот мир не в архиве, восстанавливать нечего.', 'هذا العالم غير مؤرشف، فلا شيء لاستعادته.', 'यह दुनिया संग्रहित नहीं है, इसलिए पुनर्स्थापित करने को कुछ नहीं है।'],
  'worldLibrary.actionError': ['操作失败，请稍后重试。', '操作失敗，請稍後再試。', 'The action failed. Please try again.', '操作に失敗しました。もう一度お試しください。', '작업에 실패했습니다. 다시 시도해 주세요.', 'La acción falló. Inténtalo de nuevo.', 'L’action a échoué. Veuillez réessayer.', 'Die Aktion ist fehlgeschlagen. Bitte erneut versuchen.', 'A ação falhou. Tente novamente.', 'Действие не выполнено. Повторите попытку.', 'فشلت العملية. يُرجى المحاولة مرة أخرى.', 'कार्रवाई विफल रही। कृपया फिर से प्रयास करें।'],
} as const satisfies Record<string, LocaleValues>

type WorldLibraryCatalog = Readonly<Record<keyof typeof messages, string>>

const catalogs = Object.fromEntries(
  LOCALES.map((locale, index) => [
    locale,
    Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]!])),
  ]),
) as Record<UiLocale, WorldLibraryCatalog>

export const ALL_WORLD_LIBRARY_CATALOGS = catalogs

for (const locale of LOCALES) registerMessages(locale, catalogs[locale])
