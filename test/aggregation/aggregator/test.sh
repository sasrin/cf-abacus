for u in {1..10}
do
    for i in {1..15}
    do
        cd ~/work/cf-abacus-sasrin/test/aggregation/aggregator && if ! npm run itest -- -i $i -u $u; then exit 1; fi
        cd ~/work/db && npm start
    done
done
