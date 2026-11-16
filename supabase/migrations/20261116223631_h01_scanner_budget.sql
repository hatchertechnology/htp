-- Preserve H01 validation while batching structurally inert nested strings.
create or replace function public.seosmith_check_raw_report(raw text) returns void
language plpgsql immutable set search_path='' as $$
declare tok text[]; token text; depth integer:=0; max_depth integer:=0;
  awaiting_colon boolean:=false; awaiting_version boolean:=false; is_v2 boolean:=false;
  in_string boolean:=false; escaped boolean:=false; key_text text:=''; chunk text;
  bytes bytea:=convert_to(raw,'UTF8'); offset_bytes integer:=0; root_string boolean:=false; version_text text:=''; fast_prefix text;
begin
  -- Cheap negative filter avoids any token loop for ordinary legacy reports.
  if raw !~ $pattern$"(?:s|\\u0073)(?:c|\\u0063)(?:h|\\u0068)(?:e|\\u0065)(?:m|\\u006[dD])(?:a|\\u0061)(?:_|\\u005[fF])(?:v|\\u0076)(?:e|\\u0065)(?:r|\\u0072)(?:s|\\u0073)(?:i|\\u0069)(?:o|\\u006[fF])(?:n|\\u006[eE])"[[:space:]]*:[[:space:]]*(2|[0-9]+[.eE])$pattern$ then return; end if;
  -- Byte chunks bound the regex result set and make slicing independent of UTF-8
  -- character offsets. Latin-1 maps every input byte 1:1; structural bytes are ASCII.
  while offset_bytes < octet_length(bytes) loop
    chunk:=convert_from(substring(bytes from offset_bytes+1 for 16384),'LATIN1');
    -- Skip complete string-content units without crossing an unescaped quote.
    -- A trailing backslash is left for the state machine, preserving escapes
    -- that span chunks. Root strings use key discovery until they exceed its 255-character bound.
    -- Complete a backslash escape split at the chunk boundary before batching.
    if in_string and (not root_string or length(key_text)>=256) and escaped then
      escaped:=false;
      offset_bytes:=offset_bytes+1;
      continue;
    end if;
    if in_string and (not root_string or length(key_text)>=256) and not escaped and left(chunk,1)='"' then
      in_string:=false;
      offset_bytes:=offset_bytes+1;
      continue;
    end if;
    if in_string and (not root_string or length(key_text)>=256) and not escaped then
      fast_prefix:=substring(chunk from $fast$^((?:[^"\\]|\\.)+)$fast$);
      if length(fast_prefix)>0 then
        offset_bytes:=offset_bytes+length(fast_prefix);
        continue;
      end if;
    end if;
    -- In nested containers, complete strings, commas and whitespace cannot
    -- change depth or reveal a root schema key. Consume only complete tokens;
    -- a chunk ending inside a string falls back to the existing state machine.
    -- Latin-1 makes matched character count equal to the original byte count.
    if depth>1 and not in_string and not awaiting_colon and not awaiting_version then
      fast_prefix:=substring(chunk from $fast$^((?:[[:space:],]|"(?:[^"\\]|\\.)*")+)$fast$);
      if length(fast_prefix)>0 then
        offset_bytes:=offset_bytes+length(fast_prefix);
        continue;
      end if;
    end if;
    offset_bytes:=offset_bytes+16384;
    -- A run of array scalars cannot change nesting or string state.
    if depth>1 and not in_string and chunk ~ '^[0-9,[:space:]]+$' then continue; end if;
    for tok in select regexp_matches(chunk, $tokens$["\\{}\[\]:,]|[^"\\{}\[\]:,]+$tokens$, 'g') loop
      token:=tok[1];
      if in_string then
        if escaped then
          escaped:=false;
          if root_string and length(key_text)<256 then key_text:=key_text||token; end if;
        elsif token='\' then
          escaped:=true;
          if root_string and length(key_text)<256 then key_text:=key_text||token; end if;
        elsif left(token,1)='\' then
          if root_string and length(key_text)<256 then key_text:=key_text||token; end if;
        elsif token='"' then
          in_string:=false;
          if root_string and length(key_text)<256 and ('"'||key_text||'"')::jsonb #>> '{}' = 'schema_version' then awaiting_colon:=true; end if;
        elsif root_string and length(key_text)<256 then key_text:=key_text||token;
        end if;
      else
        if awaiting_colon then
          if btrim(token,E' \t\n\r')<>'' then
            awaiting_colon:=false;
            if token=':' then awaiting_version:=true; version_text:=''; end if;
          end if;
        elsif awaiting_version then
          if token in (',','}',']','{','[',':','"') then
            awaiting_version:=false;
            if token='"' then in_string:=true; root_string:=false; key_text:=''; end if;
            if btrim(version_text,E' \t\n\r') ~ '^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' and btrim(version_text,E' \t\n\r')::numeric=2 then
              is_v2:=true;
              if max_depth>64 then raise exception 'report_depth_limit' using errcode='22023'; end if;
            end if;
          elsif length(version_text)+length(btrim(token,E' \t\n\r'))>256 then
            -- Never let an oversized numeric spelling evade schema-2 checks.
            is_v2:=true; awaiting_version:=false;
            if max_depth>64 then raise exception 'report_depth_limit' using errcode='22023'; end if;
          else version_text:=version_text||btrim(token,E' \t\n\r');
          end if;
        elsif token='"' then in_string:=true; root_string:=depth=1; key_text:='';
        end if;
        if token in ('{','[') then depth:=depth+1; max_depth:=greatest(max_depth,depth);
        elsif token in ('}',']') then depth:=depth-1; end if;
        if is_v2 and depth>64 then raise exception 'report_depth_limit' using errcode='22023'; end if;
      end if;
    end loop;
  end loop;
  if is_v2 and not (raw is json object with unique keys) then
    raise exception 'invalid_or_duplicate_json_keys' using errcode='22023';
  end if;
end $$;

