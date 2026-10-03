import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSql, tokenize } from '../../src/ZawSQL/wwwroot/js/sqlformat.js';

const fmt = (sql, o) => formatSql(sql, o);
const lines = (...l) => l.join('\n');

test('queries get one clause per line, joins and extra conditions indented', () => {
  assert.equal(fmt(`select c.id, c.name, count(o.id) as orders from customers c left join orders o on o.customer_id = c.id and o.status <> 'x' where c.active = 1 and (c.country = 'PL' or c.country = 'DE') group by c.id, c.name having count(o.id) > 5 order by orders desc limit 10`), lines(
    'SELECT c.id, c.name, COUNT(o.id) AS orders',
    'FROM customers c',
    '  LEFT JOIN orders o ON o.customer_id = c.id',
    "    AND o.status <> 'x'",
    'WHERE c.active = 1',
    "  AND (c.country = 'PL' OR c.country = 'DE')",
    'GROUP BY c.id, c.name',
    'HAVING COUNT(o.id) > 5',
    'ORDER BY orders DESC',
    'LIMIT 10'));
});

test('long select lists break one item per line; short ones stay on the keyword line', () => {
  assert.equal(fmt('select a, b from t'), 'SELECT a, b\nFROM t');
  assert.equal(fmt(`select concat(first_name, ' ', last_name) as full_name, date_format(created_at, '%Y-%m') as month from users`), lines(
    'SELECT',
    "  CONCAT(first_name, ' ', last_name) AS full_name,",
    "  DATE_FORMAT(created_at, '%Y-%m') AS month",
    'FROM users'));
  assert.equal(fmt('select a, b from t', { width: 10 }), 'SELECT\n  a,\n  b\nFROM t');
});

test('subqueries, CTEs and derived tables are indented blocks', () => {
  assert.equal(fmt('select * from t where id in (select customer_id from orders where total > 100) and ok = 1'), lines(
    'SELECT *', 'FROM t', 'WHERE id IN (', '  SELECT customer_id', '  FROM orders', '  WHERE total > 100', ')', '  AND ok = 1'));
  assert.equal(fmt('with a as (select 1 x), b as (select x from a) select * from b'), lines(
    'WITH a AS (', '  SELECT 1 x', '),', 'b AS (', '  SELECT x', '  FROM a', ')', 'SELECT *', 'FROM b'));
  assert.equal(fmt('select * from (select a from t) x'), lines('SELECT *', 'FROM (', '  SELECT a', '  FROM t', ') x'));
  assert.equal(fmt('select a from t1 union all select b from t2'), lines('SELECT a', 'FROM t1', 'UNION ALL', 'SELECT b', 'FROM t2'));
});

test('INSERT, UPDATE, DELETE and REPLACE', () => {
  assert.equal(fmt("insert into t (a, b) values (1, 'x'), (2, 'y') on duplicate key update b = values(b)"), lines(
    'INSERT INTO t (a, b)', "VALUES (1, 'x'), (2, 'y')", 'ON DUPLICATE KEY UPDATE b = VALUES(b)'));
  assert.equal(fmt("update t set a = 1, b = now() where id = 2"), 'UPDATE t\nSET a = 1, b = NOW()\nWHERE id = 2');
  assert.equal(fmt('delete from logs where created < now() - interval 30 day'), 'DELETE FROM logs\nWHERE created < NOW() - INTERVAL 30 DAY');
  assert.equal(fmt('insert into t select * from u'), 'INSERT INTO t\nSELECT *\nFROM u');
});

test('long CASE expressions are laid out, short ones stay inline', () => {
  assert.equal(fmt("select case when a > 1 then 'big' when a = 1 then 'one' else 'small, negative or something else' end as size from t"), lines(
    'SELECT CASE',
    "  WHEN a > 1 THEN 'big'",
    "  WHEN a = 1 THEN 'one'",
    "  ELSE 'small, negative or something else'",
    'END AS size',
    'FROM t'));
  assert.equal(fmt("select id, case when a > 1 then 'big' when a = 1 then 'one' else 'small, negative or something else' end as size from t"), lines(
    'SELECT',
    '  id,',
    '  CASE',
    "    WHEN a > 1 THEN 'big'",
    "    WHEN a = 1 THEN 'one'",
    "    ELSE 'small, negative or something else'",
    '  END AS size',
    'FROM t'));
  assert.equal(fmt("select case x when 1 then 'a' else 'b' end from t"), "SELECT CASE x WHEN 1 THEN 'a' ELSE 'b' END\nFROM t");
});

test('BETWEEN … AND is not split as a condition', () => {
  assert.equal(fmt('select a from t where x between 1 and 10 and y = 2'), 'SELECT a\nFROM t\nWHERE x BETWEEN 1 AND 10\n  AND y = 2');
});

test('CREATE TABLE lists one definition per line; ALTER TABLE one change per line', () => {
  assert.equal(fmt("create table t (id int unsigned not null auto_increment, name varchar(100) not null default '', created date, primary key (id)) engine=InnoDB default charset=utf8mb4"), lines(
    'CREATE TABLE t (',
    '  id INT UNSIGNED NOT NULL AUTO_INCREMENT,',
    "  name VARCHAR(100) NOT NULL DEFAULT '',",
    '  created DATE,',
    '  PRIMARY KEY (id)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'));
  assert.equal(fmt('alter table db.t add column x int after id, drop column y'), 'ALTER TABLE db.t\n  ADD COLUMN x INT AFTER id,\n  DROP COLUMN y');
  assert.equal(fmt('create view v as select a from t'), 'CREATE VIEW v AS\nSELECT a\nFROM t');
});

test('stored programs: blocks, IF/ELSEIF/ELSE, loops with labels, handlers and DELIMITER', () => {
  const src = `DELIMITER $$
create procedure p(in p_id int)
begin
declare done int default false;
declare continue handler for not found set done = true;
read_loop: loop
fetch cur into v;
if done then leave read_loop; elseif v > 10 then set v = 10; else set v = v + 1; end if;
end loop read_loop;
while v > 0 do set v = v - 1; end while;
repeat set v = v + 1; until v > 5 end repeat;
case v when 1 then set w = 1; else set w = 2; end case;
end$$
DELIMITER ;`;
  assert.equal(fmt(src), lines(
    'DELIMITER $$',
    '',
    'CREATE PROCEDURE p(IN p_id INT)',
    'BEGIN',
    '  DECLARE done INT DEFAULT FALSE;',
    '  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;',
    '  read_loop: LOOP',
    '    FETCH cur INTO v;',
    '    IF done THEN',
    '      LEAVE read_loop;',
    '    ELSEIF v > 10 THEN',
    '      SET v = 10;',
    '    ELSE',
    '      SET v = v + 1;',
    '    END IF;',
    '  END LOOP read_loop;',
    '  WHILE v > 0 DO',
    '    SET v = v - 1;',
    '  END WHILE;',
    '  REPEAT',
    '    SET v = v + 1;',
    '  UNTIL v > 5',
    '  END REPEAT;',
    '  CASE v',
    '  WHEN 1 THEN',
    '    SET w = 1;',
    '  ELSE',
    '    SET w = 2;',
    '  END CASE;',
    'END$$',
    '',
    'DELIMITER ;'));
});

test('a routine without DELIMITER is kept as one statement; BEGIN; as a transaction is not a block', () => {
  assert.equal(fmt('create function f(x int) returns int deterministic begin declare y int; set y = case when x > 0 then x else -x end; return y; end'), lines(
    'CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC', 'BEGIN', '  DECLARE y INT;', '  SET y = CASE WHEN x > 0 THEN x ELSE -x END;', '  RETURN y;', 'END'));
  assert.equal(fmt('begin; update t set a = 1; commit;'), 'BEGIN;\n\nUPDATE t\nSET a = 1;\n\nCOMMIT;');
});

test('keyword case: upper, lower or as typed; names that look like keywords keep their case', () => {
  assert.equal(fmt('SELECT A FROM T WHERE X IS NULL', { keywordCase: 'lower' }), 'select A\nfrom T\nwhere X is null');
  assert.equal(fmt('Select a From t', { keywordCase: 'keep' }), 'Select a\nFrom t');
  // Table names are case-sensitive on Linux: never touched, even when they are keywords.
  assert.equal(fmt('select * from status s join event e on e.id = s.event_id'), 'SELECT *\nFROM status s\n  JOIN event e ON e.id = s.event_id');
  assert.equal(fmt('insert into user (name) values (1)'), 'INSERT INTO user (name)\nVALUES (1)');
  assert.equal(fmt('select t.select, t.order from t'), 'SELECT t.select, t.order\nFROM t');
  // Columns named like keywords stay as typed; real keywords around them change.
  assert.equal(fmt("select status, date from orders where status = 'x' order by date desc"), "SELECT status, date\nFROM orders\nWHERE status = 'x'\nORDER BY date DESC");
  assert.equal(fmt('show full processlist; show table status like "x"; set names utf8mb4; start transaction'), 'SHOW FULL PROCESSLIST;\nSHOW TABLE STATUS LIKE "x";\nSET NAMES utf8mb4;\nSTART TRANSACTION');
});

test('indent of 4 spaces or tabs', () => {
  assert.equal(fmt('select * from t where id in (select a from u)', { indent: 4 }), 'SELECT *\nFROM t\nWHERE id IN (\n    SELECT a\n    FROM u\n)');
  assert.equal(fmt('select * from t where id in (select a from u)', { indent: 'tab' }), 'SELECT *\nFROM t\nWHERE id IN (\n\tSELECT a\n\tFROM u\n)');
});

test('operators, literals, variables and function calls keep their meaning', () => {
  assert.equal(fmt("select -1, a - -1, - -2, @x := 5, @@session.sql_mode, col->>'$.a', count(*), t.*, x'0F', _utf8mb4'z' from t", { width: 200 }),
    "SELECT -1, a - -1, - -2, @x := 5, @@session.sql_mode, col->>'$.a', COUNT(*), t.*, x'0F', _utf8mb4'z'\nFROM t");
  // A space between a function name and "(" changes how MySQL parses it, so it's kept as typed.
  assert.equal(fmt('select count (*), myfunc(1) from t'), 'SELECT count (*), myfunc(1)\nFROM t');
  assert.equal(fmt("grant select, insert on db.* to 'u'@'%'"), "GRANT SELECT, INSERT ON db.* TO 'u'@'%'");
  assert.equal(fmt("create definer=`root`@`%` view v as select 1"), 'CREATE DEFINER=`root`@`%` VIEW v AS\nSELECT 1');
});

test('comments stay where they belong and never swallow code', () => {
  assert.equal(fmt('select 1; -- trailing\n-- leading\nselect a, -- first\n b from t'), 'SELECT 1; -- trailing\n\n-- leading\nSELECT\n  a, -- first\n  b\nFROM t');
  assert.equal(fmt('select 1 -- c\n;'), 'SELECT 1 -- c\n;'); // the ; must not end up inside the comment
  assert.equal(fmt('/*!40101 SET NAMES utf8mb4 */;'), '/*!40101 SET NAMES utf8mb4 */;');
  assert.equal(fmt('SELECT /*+ MAX_EXECUTION_TIME(1000) */ a, b FROM t'), 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ a, b\nFROM t');
});

test('statements are separated by a blank line when any of them spans lines', () => {
  assert.equal(fmt('set @a = 1; set @b = 2;'), 'SET @a = 1;\nSET @b = 2;');
  assert.equal(fmt('select a from t; select 2;\n'), 'SELECT a\nFROM t;\n\nSELECT 2;\n');
  assert.equal(fmt("select * from t where a = 'x;y' and b = \"it's\""), "SELECT *\nFROM t\nWHERE a = 'x;y'\n  AND b = \"it's\"");
});

const corpus = [
  '', '   ', '-- only a comment', 'select (1', "select 'unterminated", 'select 1)', 'select a--1 from t',
  'DELIMITER ;;\nCREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN IF NEW.a IS NULL THEN SET NEW.a = 0; END IF; END ;;\nDELIMITER ;',
  'select a from t order by a limit 10 offset 5 for update', 'explain select * from t where id = 1',
  'select exists(select 1 from t where t.a = u.a) from u', 'REPLACE INTO t SET a = 1, b = 2',
  'create table t2 like t1', 'create table t3 as select * from t1', 'drop table if exists `a`, b',
  'select * from a natural join b cross join c straight_join d using (id)',
  'select sum(x) over (partition by g order by d rows between unbounded preceding and current row) from t',
  'load data infile "/x" into table t fields terminated by "," lines terminated by "\\n"',
  'select 1 into @a', 'select * from t where a in (1, (select 2), 3)', 'select ((select 1) union (select 2))',
  'create event e on schedule every 1 day do delete from t where d < now()',
];

test('never changes anything but whitespace and keyword case, and formatting twice changes nothing', () => {
  for (const sql of corpus) {
    for (const o of [{}, { keywordCase: 'lower', indent: 4 }, { keywordCase: 'keep', indent: 'tab', width: 20 }]) {
      const once = fmt(sql, o);
      const strip = s => tokenize(s).map(t => (t.t === 'word' ? t.U : t.v.trim())).join(' ');
      assert.equal(strip(once), strip(sql), sql);
      assert.equal(fmt(once, o), once, `not idempotent: ${sql}`);
    }
  }
});
